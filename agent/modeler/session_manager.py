"""In-memory + on-disk storage for recorded sessions."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Callable
from uuid import uuid4

from .recorder import SessionRecorder


@dataclass
class SessionMetadata:
    session_id: str
    url: str
    created_at: datetime

    def to_dict(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "url": self.url,
            "created_at": self.created_at.isoformat(),
        }


@dataclass
class SessionRecord:
    metadata: SessionMetadata
    recorder: SessionRecorder
    events: List[Dict[str, Any]] = field(default_factory=list)


class SessionManager:
    """Tracks active sessions and persists their artifacts."""

    def __init__(self, base_dir: Optional[Path] = None, recorder_factory: Optional[Callable[[], SessionRecorder]] = None) -> None:
        self._sessions: Dict[str, SessionRecord] = {}
        self.recorder_factory = recorder_factory or SessionRecorder
        self.base_dir = Path(base_dir or "storage").resolve()
        self.recordings_dir = self.base_dir / "recordings"
        self.schemas_dir = self.base_dir / "schemas"
        self.recordings_dir.mkdir(parents=True, exist_ok=True)
        self.schemas_dir.mkdir(parents=True, exist_ok=True)

    def create_session(self, url: str) -> SessionMetadata:
        session_id = str(uuid4())
        metadata = SessionMetadata(
            session_id=session_id,
            url=url,
            created_at=datetime.now(timezone.utc),
        )
        self._sessions[session_id] = SessionRecord(
            metadata=metadata,
            recorder=self.recorder_factory(),
        )
        # Persist empty artifacts for discoverability
        self._write_recording(session_id)
        self._write_schema(session_id)
        return metadata

    def list_sessions(self) -> List[Dict[str, Any]]:
        records = sorted(self._sessions.values(), key=lambda r: r.metadata.created_at, reverse=True)
        return [record.metadata.to_dict() for record in records]

    def get_session(self, session_id: str) -> SessionRecord:
        if session_id not in self._sessions:
            raise KeyError(session_id)
        return self._sessions[session_id]

    def record_event(self, session_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        record = self.get_session(session_id)
        node = record.recorder.record_browser_use_event(payload)
        record.events.append(payload)
        self._write_recording(session_id, record.events)
        self._write_schema(session_id, record.recorder.flow().to_dict())
        return {
            "node": node.to_dict(),
            "graph": record.recorder.flow().to_dict(),
        }

    def schema_path(self, session_id: str) -> Path:
        return (self.schemas_dir / f"{session_id}.json").resolve()

    def recording_path(self, session_id: str) -> Path:
        return (self.recordings_dir / f"{session_id}.json").resolve()

    def _write_recording(self, session_id: str, events: Optional[List[Dict[str, Any]]] = None) -> None:
        path = self.recording_path(session_id)
        with path.open("w", encoding="utf-8") as fh:
            json.dump(events or [], fh, indent=2)


    def persist_schema(self, session_id: str) -> None:
        record = self.get_session(session_id)
        self._write_schema(session_id, record.recorder.flow().to_dict())

    def persist_recording(self, session_id: str) -> None:
        record = self.get_session(session_id)
        self._write_recording(session_id, record.events)

    def _write_schema(self, session_id: str, schema: Optional[Dict[str, Any]] = None) -> None:
        path = self.schema_path(session_id)
        with path.open("w", encoding="utf-8") as fh:
            json.dump(schema or {"entry": None, "nodes": {}, "edges": {}}, fh, indent=2)
