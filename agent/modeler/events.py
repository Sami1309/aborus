"""Event models used by the modeler service.

These classes mirror the instrumentation emitted by browser-use agents so we can
normalize deterministic flows and feed them to the flow graph builder.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional


class ActionType(str, Enum):
    """Canonical action categories recognised by the modeler."""

    NAVIGATE = "navigate"
    CLICK = "click"
    INPUT = "input"
    WAIT_FOR = "wait_for"
    ASSERT = "assert"
    OTHER = "other"


@dataclass
class DomSnapshot:
    """Subset of DOM details required to reconstruct selectors."""

    tag: str
    id: Optional[str] = None
    classes: List[str] = field(default_factory=list)
    role: Optional[str] = None
    name: Optional[str] = None
    text: Optional[str] = None
    data_attributes: Dict[str, str] = field(default_factory=dict)
    xpath: Optional[str] = None
    css_path: Optional[str] = None

    @classmethod
    def from_browser_use_payload(cls, payload: Dict[str, Any]) -> "DomSnapshot":
        """Build a snapshot from the browser-use event payload."""

        attrs = payload.get("attributes", {})
        data_attrs = {k[5:]: v for k, v in attrs.items() if k.startswith("data-")}
        return cls(
            tag=payload.get("tag", "div"),
            id=attrs.get("id"),
            classes=payload.get("classList", []),
            role=attrs.get("role"),
            name=payload.get("accessibleName"),
            text=payload.get("innerText"),
            data_attributes=data_attrs,
            xpath=payload.get("xpath"),
            css_path=payload.get("cssPath"),
        )


@dataclass
class BrowserContext:
    """Contextual information for an action event."""

    url: str
    frame: Optional[str] = None
    title: Optional[str] = None


@dataclass
class ActionEvent:
    """Normalized action emitted by the session recorder."""

    event_id: str
    order: int
    occurred_at: datetime
    type: ActionType
    context: BrowserContext
    dom_snapshot: Optional[DomSnapshot] = None
    payload: Dict[str, Any] = field(default_factory=dict)

    def short_description(self) -> str:
        """Human-facing summary used before LLM embellishment."""

        target = ""
        if self.dom_snapshot:
            tag = self.dom_snapshot.tag
            ident = self.dom_snapshot.id or self.dom_snapshot.name or ""
            target = f" {tag} {ident}".strip()
        return f"{self.type.value}{target and f' → {target}'}"


@dataclass
class FlowIntent:
    """LLM-derived intent metadata for a flow node."""

    summary: str
    semantic_action: Optional[str] = None
    user_value: Optional[str] = None
    confidence: float = 0.5

    def to_payload(self) -> Dict[str, Any]:
        return {
            "summary": self.summary,
            "semantic_action": self.semantic_action,
            "user_value": self.user_value,
            "confidence": self.confidence,
        }
