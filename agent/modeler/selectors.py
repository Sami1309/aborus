"""Selector mining heuristics for recorded actions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List

from .events import ActionEvent, DomSnapshot


@dataclass
class SelectorCandidate:
    value: str
    score: float
    origin: str

    def to_dict(self) -> dict[str, object]:
        return {"value": self.value, "score": self.score, "origin": self.origin}


class SelectorMiner:
    """Generate ranked selector candidates from a DOM snapshot."""

    def __init__(self, weight_id: float = 1.0, weight_role: float = 0.9, weight_text: float = 0.7, weight_css: float = 0.3) -> None:
        self.weight_id = weight_id
        self.weight_role = weight_role
        self.weight_text = weight_text
        self.weight_css = weight_css

    def mine(self, event: ActionEvent) -> List[SelectorCandidate]:
        if not event.dom_snapshot:
            return []
        return self._rank(event.dom_snapshot, event.payload.get("selector"))

    def _rank(self, snapshot: DomSnapshot, explicit_selector: str | None) -> List[SelectorCandidate]:
        candidates: list[SelectorCandidate] = []
        if explicit_selector:
            candidates.append(SelectorCandidate(explicit_selector, 1.1, "browser_use"))
        if snapshot.id:
            candidates.append(SelectorCandidate(f"#{snapshot.id}", self.weight_id, "dom_id"))
        if snapshot.role and snapshot.name:
            candidates.append(
                SelectorCandidate(
                    f"getByRole('{snapshot.role}', {{ name: '{snapshot.name}' }})",
                    self.weight_role,
                    "aria_role",
                )
            )
        if snapshot.text:
            text = snapshot.text.strip().replace("'", "\'")
            if 0 < len(text) <= 80:
                candidates.append(SelectorCandidate(f"getByText('{text}')", self.weight_text, "text"))
        if snapshot.css_path:
            candidates.append(SelectorCandidate(snapshot.css_path, self.weight_css, "css_path"))
        elif snapshot.classes:
            class_selector = ".".join(cls for cls in snapshot.classes[:3])
            if class_selector:
                candidates.append(SelectorCandidate(f"{snapshot.tag}.{class_selector}", self.weight_css, "classlist"))
        if snapshot.xpath:
            candidates.append(SelectorCandidate(snapshot.xpath, self.weight_css - 0.1, "xpath"))
        seen: set[str] = set()
        unique: list[SelectorCandidate] = []
        for candidate in sorted(candidates, key=lambda c: c.score, reverse=True):
            if candidate.value not in seen:
                unique.append(candidate)
                seen.add(candidate.value)
        return unique

    @staticmethod
    def serialize(candidates: Iterable[SelectorCandidate]) -> List[dict[str, object]]:
        return [c.to_dict() for c in candidates]
