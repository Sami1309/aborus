"""LLM integration for annotating flow nodes."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

try:
    import requests  # type: ignore
except ModuleNotFoundError:
    requests = None

from .events import ActionEvent, FlowIntent


@dataclass
class LlmClientConfig:
    provider: str = "anthropic"
    model: str = "claude-3-5-sonnet-20241022"
    api_key_env: str = "ANTHROPIC_API_KEY"
    max_output_tokens: int = 256
    api_url: str = "https://api.anthropic.com/v1/messages"


class FlowAnnotator:
    """Annotates action events using an LLM, with deterministic fallbacks."""

    def __init__(self, config: Optional[LlmClientConfig] = None) -> None:
        self.config = config or LlmClientConfig()
        self._api_key = os.getenv(self.config.api_key_env)

    def annotate(self, event: ActionEvent) -> FlowIntent:
        base_summary = event.short_description()
        if not self._api_key:
            return FlowIntent(summary=base_summary, semantic_action=None, user_value=None, confidence=0.2)
        try:
            payload = self._build_payload(event)
            data = self._call_llm(payload)
            return self._parse_response(data, fallback_summary=base_summary)
        except Exception:
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
        prompt = (
            "You are assisting a browser automation engineer. "
            "Summarize the user's intent for the following browser event and "
            "decide whether the action should be described semantically or via a DOM selector. "
            "Reply with JSON: {\"summary\": str, \"semantic_action\": str|null, "
            "\"user_value\": str|null, \"confidence\": float}."
        )
        content = (
            f"Event type: {event.type.value}\n"
            f"URL: {event.context.url}\n"
            f"DOM: {dom_desc}\n"
            f"Payload: {json.dumps(event.payload)}"
        )
        return {
            "model": self.config.model,
            "max_output_tokens": self.config.max_output_tokens,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": content},
            ],
        }

    def _call_llm(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if requests is None:
            raise RuntimeError("requests dependency not available")
        headers = {
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "x-api-key": self._api_key,
        }
        response = requests.post(self.config.api_url, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        return response.json()

    def _parse_response(self, data: Dict[str, Any], *, fallback_summary: str) -> FlowIntent:
        try:
            content = data["content"][0]["text"]
            parsed = json.loads(content)
            return FlowIntent(
                summary=parsed.get("summary", fallback_summary),
                semantic_action=parsed.get("semantic_action"),
                user_value=parsed.get("user_value"),
                confidence=float(parsed.get("confidence", 0.5)),
            )
        except Exception:
            return FlowIntent(summary=fallback_summary, semantic_action=None, user_value=None, confidence=0.3)
