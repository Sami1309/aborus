"""Flow graph primitives for the modeler."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional

from .events import ActionEvent, FlowIntent


@dataclass
class FlowNode:
    """Single node in the flow graph."""

    node_id: str
    event: ActionEvent
    selectors: List[str]
    intent: FlowIntent
    metadata: Dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, object]:
        return {
            "node_id": self.node_id,
            "event": {
                "event_id": self.event.event_id,
                "order": self.event.order,
                "type": self.event.type.value,
                "url": self.event.context.url,
                "frame": self.event.context.frame,
                "title": self.event.context.title,
                "payload": self.event.payload,
            },
            "selectors": self.selectors,
            "intent": self.intent.to_payload(),
            "metadata": self.metadata,
        }


class FlowGraph:
    """Mutable directed graph assembled during recording."""

    def __init__(self) -> None:
        self._nodes: Dict[str, FlowNode] = {}
        self._edges: Dict[str, List[str]] = {}
        self._entry: Optional[str] = None
        self._tail: Optional[str] = None

    def add_node(self, node: FlowNode) -> None:
        self._nodes[node.node_id] = node
        self._edges.setdefault(node.node_id, [])
        if self._entry is None:
            self._entry = node.node_id
        if self._tail and node.node_id not in self._edges[self._tail]:
            self._edges[self._tail].append(node.node_id)
        self._tail = node.node_id

    def connect(self, source_id: str, target_id: str) -> None:
        self._edges.setdefault(source_id, [])
        if target_id not in self._edges[source_id]:
            self._edges[source_id].append(target_id)

    def remove_edge(self, source_id: str, target_id: str) -> None:
        neighbours = self._edges.get(source_id, [])
        if target_id in neighbours:
            neighbours.remove(target_id)

    def rewire(self, source_id: str, old_target: str, new_target: str) -> None:
        neighbours = self._edges.get(source_id, [])
        if old_target in neighbours:
            idx = neighbours.index(old_target)
            neighbours[idx] = new_target

    def entry_node(self) -> Optional[FlowNode]:
        return self._nodes.get(self._entry) if self._entry else None

    def nodes(self) -> Iterable[FlowNode]:
        return self._nodes.values()

    def edges(self) -> Dict[str, List[str]]:
        return {k: list(v) for k, v in self._edges.items()}

    def to_dict(self) -> Dict[str, object]:
        return {
            "entry": self._entry,
            "nodes": {node_id: node.to_dict() for node_id, node in self._nodes.items()},
            "edges": {source: targets[:] for source, targets in self._edges.items()},
        }

    def get(self, node_id: str) -> Optional[FlowNode]:
        return self._nodes.get(node_id)

    def update_node(self, node_id: str, *, selectors: Optional[List[str]] = None, intent: Optional[FlowIntent] = None) -> None:
        node = self._nodes[node_id]
        if selectors is not None:
            node.selectors = selectors
        if intent is not None:
            node.intent = intent

    def prune_after(self, node_id: str) -> None:
        """Remove all nodes downstream of the provided node."""

        def _collect(start: str, acc: set[str]) -> None:
            for nxt in self._edges.get(start, []):
                if nxt not in acc:
                    acc.add(nxt)
                    _collect(nxt, acc)

        discard: set[str] = set()
        _collect(node_id, discard)
        for nid in discard:
            self._nodes.pop(nid, None)
            self._edges.pop(nid, None)
        for targets in self._edges.values():
            for nid in list(targets):
                if nid in discard:
                    targets.remove(nid)
        if self._tail in discard:
            self._tail = node_id

    def __len__(self) -> int:
        return len(self._nodes)
