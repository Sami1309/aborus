"""Session recorder that transforms browser-use telemetry into a flow graph."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional
from uuid import uuid4

from .events import ActionEvent, ActionType, BrowserContext, DomSnapshot
from .graph import FlowGraph, FlowNode
from .llm import FlowAnnotator
from .selectors import SelectorMiner


class SessionRecorder:
    """Accumulates action events and incrementally updates the flow graph."""

    def __init__(self, selector_miner: Optional[SelectorMiner] = None, annotator: Optional[FlowAnnotator] = None) -> None:
        self.selector_miner = selector_miner or SelectorMiner()
        self.annotator = annotator or FlowAnnotator()
        self.graph = FlowGraph()
        self._order = 0

    def record_browser_use_event(self, event_payload: Dict[str, Any]) -> FlowNode:
        """Ingest an event emitted by browser-use."""

        action_event = self._normalize_event(event_payload)
        selector_candidates = self.selector_miner.mine(action_event)
        intent = self.annotator.annotate(action_event)
        node = FlowNode(
            node_id=action_event.event_id,
            event=action_event,
            selectors=[candidate.value for candidate in selector_candidates],
            intent=intent,
            metadata={"selector_candidates": [c.to_dict() for c in selector_candidates]},
        )
        self.graph.add_node(node)
        return node

    def flow(self) -> FlowGraph:
        return self.graph

    def _normalize_event(self, payload: Dict[str, Any]) -> ActionEvent:
        self._order += 1
        event_type = _resolve_action_type(payload)
        timestamp = payload.get("timestamp")
        occurred_at = datetime.fromisoformat(timestamp) if isinstance(timestamp, str) else datetime.utcnow()
        context = BrowserContext(
            url=payload.get("url", ""),
            frame=payload.get("frame"),
            title=payload.get("title"),
        )
        dom_snapshot = None
        if payload.get("dom"):
            dom_snapshot = DomSnapshot.from_browser_use_payload(payload["dom"])
        action_event = ActionEvent(
            event_id=payload.get("event_id") or str(uuid4()),
            order=self._order,
            occurred_at=occurred_at,
            type=event_type,
            context=context,
            dom_snapshot=dom_snapshot,
            payload=payload.get("payload", {}),
        )
        return action_event


def _resolve_action_type(payload: Dict[str, Any]) -> ActionType:
    name = (payload.get("category") or payload.get("type") or "other").lower()
    if name in {"click", "press"}:
        return ActionType.CLICK
    if name in {"input", "type"}:
        return ActionType.INPUT
    if name in {"navigate", "goto"}:
        return ActionType.NAVIGATE
    if name in {"wait", "wait_for"}:
        return ActionType.WAIT_FOR
    if name in {"assert", "verify"}:
        return ActionType.ASSERT
    return ActionType.OTHER
