"""LLM integration for annotating flow nodes."""

from __future__ import annotations

import json
import logging
import os
import copy
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Dict, List, Optional

try:  # pragma: no cover - optional dependency for runtime only
    import anthropic  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    anthropic = None

from .events import ActionEvent, FlowIntent

if TYPE_CHECKING:  # pragma: no cover - type check helpers
    from .graph import FlowGraph


logger = logging.getLogger(__name__)


@dataclass
class LlmClientConfig:
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-5-20250929"
    api_key_env: str = "ANTHROPIC_API_KEY"
    model_env: str = "ANTHROPIC_MODEL"
    flowchart_model_env: str = "ANTHROPIC_FLOWCHART_MODEL"
    max_tokens: int = 1024


class FlowAnnotator:
    """Annotates action events using an LLM, with deterministic fallbacks."""

    def __init__(self, config: Optional[LlmClientConfig] = None) -> None:
        self.config = config or LlmClientConfig()
        self._api_key = os.getenv(self.config.api_key_env)
        model_override = os.getenv(self.config.model_env)
        self._model = model_override or self.config.model
        self._client: Optional["anthropic.Anthropic"] = None

    def annotate(self, event: ActionEvent) -> FlowIntent:
        base_summary = event.short_description()
        if not self._api_key:
            return FlowIntent(summary=base_summary, semantic_action=None, user_value=None, confidence=0.2)
        try:
            payload = self._build_payload(event)
            data = self._call_llm(payload)
            return self._parse_response(data, fallback_summary=base_summary)
        except Exception:
            logger.exception("Claude annotation failed for event %s", event.event_id)
            return FlowIntent(summary=base_summary, semantic_action=None, user_value=None, confidence=0.1)

    def _build_payload(self, event: ActionEvent) -> Dict[str, Any]:
        dom = event.dom_snapshot
        dom_desc = ""
        if dom:
            dom_desc = json.dumps(
                {
                    "tag": dom.tag,
                    "id": dom.id,
                    "classes": dom.classes,
                    "role": dom.role,
                    "name": dom.name,
                    "text": dom.text,
                }
            )
        system_prompt = (
            "You are assisting a browser automation engineer. "
            "Summarize the user's intent for the following browser event and "
            "decide whether the action should be described semantically or via a DOM selector. "
            "Reply with JSON: {\"summary\": str, \"semantic_action\": str|null, "
            "\"user_value\": str|null, \"confidence\": float}."
        )
        user_content = (
            f"Event type: {event.type.value}\n"
            f"URL: {event.context.url}\n"
            f"DOM: {dom_desc}\n"
            f"Payload: {json.dumps(event.payload)}"
        )
        return {
            "model": self._model,
            "max_tokens": self.config.max_tokens,
            "system": system_prompt,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_content},
                    ],
                }
            ],
        }

    def _client_or_raise(self) -> "anthropic.Anthropic":
        if anthropic is None:
            raise RuntimeError("anthropic client library not installed")
        if not self._client:
            if not self._api_key:
                raise RuntimeError("Anthropic API key missing")
            self._client = anthropic.Anthropic(api_key=self._api_key)
        return self._client

    def _call_llm(self, payload: Dict[str, Any]) -> Any:
        client = self._client_or_raise()
        try:
            return client.messages.create(**payload)
        except Exception:
            logger.exception("Claude API request failed during annotation")
            raise

    def _parse_response(self, data: Any, *, fallback_summary: str) -> FlowIntent:
        try:
            content = _extract_text_blocks(data)
            if not content:
                raise ValueError("no text blocks returned")
            try:
                parsed = _loads_best_effort(content)
            except Exception:
                logger.error("Claude annotation raw content: %s", content)
                raise
            return FlowIntent(
                summary=parsed.get("summary", fallback_summary),
                semantic_action=parsed.get("semantic_action"),
                user_value=parsed.get("user_value"),
                confidence=float(parsed.get("confidence", 0.5)),
            )
        except Exception:
            logger.exception("Failed to parse Claude response for annotation")
            return FlowIntent(summary=fallback_summary, semantic_action=None, user_value=None, confidence=0.3)


class FlowChartGenerator:
    """Leverages an LLM to transform a flow graph into a plain-English flow chart."""

    def __init__(self, config: Optional[LlmClientConfig] = None) -> None:
        self.config = config or LlmClientConfig()
        self._api_key = os.getenv(self.config.api_key_env)
        flowchart_override = os.getenv(self.config.flowchart_model_env)
        model_override = os.getenv(self.config.model_env)
        self._model = flowchart_override or model_override or self.config.model
        self._client: Optional["anthropic.Anthropic"] = None

    def generate(self, session_id: str, graph: "FlowGraph") -> Dict[str, Any]:
        nodes = self._extract_nodes(graph)
        edges = graph.edges()
        timestamp = datetime.now(timezone.utc).isoformat()
        if not nodes:
            return {
                "session_id": session_id,
                "generated_at": timestamp,
                "model": self._model,
                "steps": [],
                "edges": edges,
                "source": {"type": "heuristic", "reason": "empty-graph"},
            }

        if not self._api_key:
            return self._fallback_chart(session_id, nodes, edges, timestamp, reason="missing-api-key")

        try:
            payload = self._build_payload(nodes, edges)
            data = self._call_llm(payload)
            parsed_steps = self._parse_response(data, nodes)
            if not parsed_steps:
                raise ValueError("LLM response missing steps")
            return {
                "session_id": session_id,
                "generated_at": timestamp,
                "model": self._model,
                "steps": parsed_steps,
                "edges": edges,
                "source": {"type": "llm", "provider": self.config.provider, "model": self._model},
            }
        except Exception:
            logger.exception("Claude flowchart generation failed for session %s", session_id)
            return self._fallback_chart(session_id, nodes, edges, timestamp, reason="llm-error")

    def _extract_nodes(self, graph: "FlowGraph") -> List[Dict[str, Any]]:
        extracted: List[Dict[str, Any]] = []
        for node in sorted(graph.nodes(), key=lambda n: n.event.order):
            selectors = list(node.selectors)
            metadata = node.metadata or {}
            extracted.append(
                {
                    "node_id": node.node_id,
                    "order": node.event.order,
                    "action_type": node.event.type.value,
                    "url": node.event.context.url,
                    "title": node.event.context.title,
                    "intent_summary": node.intent.summary,
                    "semantic_action": node.intent.semantic_action,
                    "user_value": node.intent.user_value,
                    "confidence": node.intent.confidence,
                    "selectors": selectors,
                    "selector_candidates": metadata.get("selector_candidates", []),
                    "payload": node.event.payload,
                }
            )
        return extracted

    def _build_payload(self, nodes: List[Dict[str, Any]], edges: Dict[str, List[str]]) -> Dict[str, Any]:
        system_prompt = (
            "You are Claude Sonnet 4.5 acting as an automation flow architect. "
            "Given recorded browser actions, summarise them as an automation flow chart. "
            "Produce STRICT JSON with keys: steps (ordered list). Each step must include: node_id, title, "
            "description, execution_mode (deterministic, llm, or hybrid), dom_selectors (list of strings), and hints "
            "(object with optional keys such as user_value or notes). Craft natural language titles (2-8 words) and "
            "descriptions (1-2 sentences) that capture user intent. Preserve provided DOM selectors exactly unless "
            "the instructions explicitly require a change. Prefer execution_mode='deterministic' when selectors are "
            "reliable, 'llm' when adaptive reasoning is required, and 'hybrid' when combining both yields better results."
        )
        user_content = json.dumps({"nodes": nodes, "edges": edges}, indent=2)
        return {
            "model": self._model,
            "max_tokens": self.config.max_tokens,
            "system": system_prompt,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "Convert the following recorded automation into the requested JSON flow chart. "
                                "Do not add commentary outside JSON.\n" + user_content
                            ),
                        }
                    ],
                }
            ],
        }

    def _client_or_raise(self) -> "anthropic.Anthropic":
        if anthropic is None:
            raise RuntimeError("anthropic client library not installed")
        if not self._client:
            if not self._api_key:
                raise RuntimeError("Anthropic API key missing")
            self._client = anthropic.Anthropic(api_key=self._api_key)
        return self._client

    def _call_llm(self, payload: Dict[str, Any]) -> Any:
        client = self._client_or_raise()
        try:
            return client.messages.create(**payload)
        except Exception:
            logger.exception("Claude API request failed during flowchart generation")
            raise

    def _parse_response(self, data: Any, baseline_nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        content = _extract_text_blocks(data)
        if not content:
            raise ValueError("no text content provided by LLM")
        try:
            parsed = _loads_best_effort(content)
        except Exception:
            logger.error("Claude flowchart raw content: %s", content)
            logger.exception("Failed to parse Claude response for flowchart generation")
            raise

        steps = parsed.get("steps")
        if not isinstance(steps, list):
            raise ValueError("LLM response missing steps array")

        fallback_lookup = {node["node_id"]: node for node in baseline_nodes}
        normalised: List[Dict[str, Any]] = []
        for step in steps:
            node_id = step.get("node_id")
            if not node_id or node_id not in fallback_lookup:
                continue
            baseline = fallback_lookup[node_id]
            fallback_title = baseline.get("intent_summary") or baseline.get("action_type", "").replace("_", " ").title()
            fallback_description = baseline.get("intent_summary") or baseline.get("action_type", "")
            title = _ensure_title(step.get("title"), fallback_title)
            description = _ensure_description(step.get("description"), fallback_description)
            execution_mode = _ensure_execution_mode(step.get("execution_mode") or self._suggest_mode(baseline))
            selectors = step.get("dom_selectors") or baseline.get("selectors", [])
            hints = step.get("hints") or {}
            normalised.append(
                {
                    "node_id": node_id,
                    "order": baseline["order"],
                    "title": title,
                    "description": description,
                    "execution_mode": execution_mode,
                    "dom_selectors": selectors,
                    "hints": hints,
                    "source": "llm",
                }
            )
        normalised.sort(key=lambda item: item["order"])
        return normalised

    def _fallback_chart(
        self,
        session_id: str,
        nodes: List[Dict[str, Any]],
        edges: Dict[str, List[str]],
        timestamp: str,
        *,
        reason: str,
    ) -> Dict[str, Any]:
        steps = []
        for node in nodes:
            fallback_title = node.get("intent_summary") or node.get("action_type", "").replace("_", " ").title()
            fallback_description = node.get("intent_summary") or node.get("action_type", "")
            steps.append(
                {
                    "node_id": node["node_id"],
                    "order": node["order"],
                    "title": _ensure_title(None, fallback_title),
                    "description": _ensure_description(None, fallback_description),
                    "execution_mode": _ensure_execution_mode(self._suggest_mode(node)),
                    "dom_selectors": node.get("selectors", []),
                    "hints": {
                        "semantic_action": node.get("semantic_action"),
                        "user_value": node.get("user_value"),
                        "confidence": node.get("confidence"),
                    },
                    "source": reason,
                }
            )
        steps.sort(key=lambda item: item["order"])
        return {
            "session_id": session_id,
            "generated_at": timestamp,
            "model": self._model,
            "steps": steps,
            "edges": edges,
            "source": {"type": "heuristic", "reason": reason},
        }

    def _suggest_mode(self, node: Dict[str, Any]) -> str:
        if node.get("semantic_action") or node.get("action_type") in {"other", "assert"}:
            return "llm"
        if node.get("selectors"):
            return "deterministic"
        return "llm"



class FlowChartEditor:
    """Applies natural language edits to an existing flow chart using Claude."""

    def __init__(self, config: Optional[LlmClientConfig] = None) -> None:
        self.config = config or LlmClientConfig()
        self._api_key = os.getenv(self.config.api_key_env)
        flowchart_override = os.getenv(self.config.flowchart_model_env)
        model_override = os.getenv(self.config.model_env)
        self._model = flowchart_override or model_override or self.config.model
        self._client: Optional["anthropic.Anthropic"] = None

    def edit(self, flowchart: Dict[str, Any], instructions: str) -> Dict[str, Any]:
        instructions_text = (instructions or '').strip()
        if not instructions_text:
            raise ValueError('Instructions must not be empty')
        steps = list(flowchart.get('steps') or [])
        if not steps:
            raise ValueError('Flow chart is empty, generate one before editing')
        edges = copy.deepcopy(flowchart.get('edges') or {})
        timestamp = datetime.now(timezone.utc).isoformat()

        if not self._api_key:
            return self._fallback(flowchart, instructions_text, timestamp, reason='missing-api-key')

        try:
            payload = self._build_payload(flowchart, instructions_text)
            data = self._call_llm(payload)
            parsed = self._parse_response(data, steps, edges)
        except Exception:
            logger.exception('Claude flowchart edit failed for session %s', flowchart.get('session_id'))
            return self._fallback(flowchart, instructions_text, timestamp, reason='llm-error')

        result = copy.deepcopy(flowchart)
        result['steps'] = parsed['steps']
        result['edges'] = parsed.get('edges', edges)
        result['model'] = self._model
        result['generated_at'] = timestamp
        result['source'] = {
            'type': 'llm',
            'provider': self.config.provider,
            'model': self._model,
            'operation': 'edit',
        }
        history = list(flowchart.get('history', []))
        history.append(
            {
                'timestamp': timestamp,
                'instructions': instructions_text,
                'model': self._model,
                'provider': self.config.provider,
                'status': 'success',
                'notes': parsed.get('notes'),
            }
        )
        result['history'] = history
        return result

    def _build_payload(self, flowchart: Dict[str, Any], instructions: str) -> Dict[str, Any]:
        system_prompt = (
            'You are Claude Sonnet 4.5 refining an automation flow chart. '
            'You receive the existing steps and a natural language change request. '
            'Return STRICT JSON with keys: steps (ordered list), optional edges, and optional notes. '
            'Each step must include node_id, title, description, execution_mode (deterministic, llm, or hybrid), '
            'dom_selectors, and hints. Titles and descriptions should be natural language summaries. '
            'Preserve existing DOM selectors unless the change request explicitly requires updates.'
        )
        payload = {
            'current_flowchart': {
                'steps': flowchart.get('steps', []),
                'edges': flowchart.get('edges', {}),
                'session_id': flowchart.get('session_id'),
            },
            'instructions': instructions,
        }
        return {
            'model': self._model,
            'max_tokens': self.config.max_tokens,
            'system': system_prompt,
            'messages': [
                {
                    'role': 'user',
                    'content': [
                        {
                            'type': 'text',
                            'text': 'Apply the requested changes to the automation. Respond with JSON only.\n'
                                    + json.dumps(payload, indent=2),
                        }
                    ],
                }
            ],
        }

    def _parse_response(
        self,
        data: Any,
        baseline_steps: List[Dict[str, Any]],
        baseline_edges: Dict[str, Any],
    ) -> Dict[str, Any]:
        content = _extract_text_blocks(data)
        if not content:
            raise ValueError('Claude edit response was empty')
        try:
            parsed = _loads_best_effort(content)
        except Exception as exc:
            logger.error('Claude edit raw content: %s', content)
            raise ValueError('Claude edit response was not valid JSON') from exc

        steps_payload = parsed.get('steps')
        if not isinstance(steps_payload, list):
            raise ValueError('Claude edit response missing steps array')

        lookup = {step.get('node_id'): step for step in baseline_steps if step.get('node_id')}
        normalised: List[Dict[str, Any]] = []
        for index, step in enumerate(steps_payload):
            node_id = step.get('node_id') or f'generated-{index + 1}'
            baseline = lookup.get(node_id, {
                'node_id': node_id,
                'order': step.get('order', index + 1),
                'title': step.get('title'),
                'description': step.get('description'),
                'execution_mode': step.get('execution_mode'),
                'dom_selectors': step.get('dom_selectors') or [],
                'hints': step.get('hints') or {},
            })
            order_raw = step.get('order', baseline.get('order', index + 1))
            try:
                order_value = int(order_raw)
            except (TypeError, ValueError):
                order_value = index + 1
            title = _ensure_title(step.get('title'), baseline.get('title') or baseline.get('description'))
            description = _ensure_description(step.get('description'), baseline.get('description') or baseline.get('title'))
            execution_mode = _ensure_execution_mode(step.get('execution_mode') or baseline.get('execution_mode'))
            selectors = step.get('dom_selectors')
            if not selectors and node_id in lookup:
                selectors = lookup[node_id].get('dom_selectors') or []
            elif not selectors:
                selectors = baseline.get('dom_selectors') or []
            hints = step.get('hints')
            if hints is None:
                hints = baseline.get('hints') or {}
            normalised.append(
                {
                    'node_id': node_id,
                    'order': order_value,
                    'title': title,
                    'description': description,
                    'execution_mode': execution_mode,
                    'dom_selectors': selectors,
                    'hints': hints,
                    'source': 'llm-edit',
                }
            )

        normalised.sort(key=lambda item: item['order'])

        edges_payload = parsed.get('edges')
        if isinstance(edges_payload, dict):
            try:
                edges = {str(key): list(value) for key, value in edges_payload.items()}
            except Exception:
                edges = copy.deepcopy(baseline_edges)
        else:
            edges = copy.deepcopy(baseline_edges)

        notes = parsed.get('notes') or parsed.get('changelog')

        return {'steps': normalised, 'edges': edges, 'notes': notes}

    def _client_or_raise(self) -> "anthropic.Anthropic":
        if anthropic is None:
            raise RuntimeError('anthropic client library not installed')
        if not self._client:
            if not self._api_key:
                raise RuntimeError('Anthropic API key missing')
            self._client = anthropic.Anthropic(api_key=self._api_key)
        return self._client

    def _call_llm(self, payload: Dict[str, Any]) -> Any:
        client = self._client_or_raise()
        try:
            return client.messages.create(**payload)
        except Exception:
            logger.exception('Claude API request failed during flowchart editing')
            raise

    def _fallback(
        self,
        flowchart: Dict[str, Any],
        instructions: str,
        timestamp: str,
        *,
        reason: str,
    ) -> Dict[str, Any]:
        result = copy.deepcopy(flowchart)
        result['generated_at'] = timestamp
        result['model'] = self._model
        result['source'] = {
            'type': 'heuristic',
            'reason': reason,
            'operation': 'edit',
        }
        history = list(flowchart.get('history', []))
        history.append(
            {
                'timestamp': timestamp,
                'instructions': instructions,
                'status': 'fallback',
                'reason': reason,
            }
        )
        result['history'] = history
        return result


def _ensure_title(value: Optional[str], fallback: Optional[str]) -> str:
    text = (value or fallback or 'Step').strip()
    if not text:
        return 'Step'
    return text[0].upper() + text[1:] if len(text) > 1 else text.upper()


def _ensure_description(value: Optional[str], fallback: Optional[str]) -> str:
    text = (value or fallback or '').strip()
    if not text:
        return 'Describe the action.'
    if text[-1] not in '.!?':
        text = f"{text}."
    return text


def _ensure_execution_mode(value: Optional[str]) -> str:
    if not value:
        return 'deterministic'
    normalised = value.lower().strip()
    if normalised in {'deterministic', 'llm', 'hybrid'}:
        return normalised
    if 'llm' in normalised:
        return 'llm'
    if 'hybrid' in normalised:
        return 'hybrid'
    return 'deterministic'



def _extract_text_blocks(data: Any) -> str:
    """Concatenate text blocks from an Anthropic Messages response."""

    if hasattr(data, "content"):
        blocks = getattr(data, "content")  # Anthropic SDK object path
    elif isinstance(data, dict):
        blocks = data.get("content", [])
    else:
        blocks = []

    fragments: List[str] = []
    for block in blocks:
        if isinstance(block, dict):
            if block.get("type") == "text" and block.get("text"):
                fragments.append(str(block["text"]))
        else:
            block_type = getattr(block, "type", None)
            text = getattr(block, "text", None)
            if block_type == "text" and text:
                fragments.append(str(text))
    return "\n".join(fragment.strip() for fragment in fragments if fragment).strip()


def _loads_best_effort(raw_text: str) -> Any:
    """Attempt to load JSON from Claude responses that may include formatting wrappers."""

    text = (raw_text or "").strip()
    if not text:
        raise ValueError("empty response")

    # First try the entire string
    try:
        return json.loads(text)
    except json.JSONDecodeError as primary_error:
        last_error: Exception = primary_error

    # Handle fenced code blocks ```json ... ```
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", raw_text, re.DOTALL)
    if fence_match:
        candidate = fence_match.group(1).strip()
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as fence_error:
            last_error = fence_error

    # Scan for the first decodable JSON object/array starting point within the text
    decoder = json.JSONDecoder()
    for match in re.finditer(r"[\{\[]", raw_text):
        index = match.start()
        try:
            candidate_obj, _ = decoder.raw_decode(raw_text[index:])
            return candidate_obj
        except json.JSONDecodeError as raw_error:
            last_error = raw_error
            continue

    raise ValueError("unable to parse JSON payload") from last_error
