"""In-memory + on-disk storage for recorded sessions."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
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
    flowchart: Optional[Dict[str, Any]] = None


class SessionManager:
    """Tracks active sessions and persists their artifacts."""

    def __init__(self, base_dir: Optional[Path] = None, recorder_factory: Optional[Callable[[], SessionRecorder]] = None) -> None:
        self._sessions: Dict[str, SessionRecord] = {}
        self._automations: Dict[str, Dict[str, Any]] = {}
        self._runs: Dict[str, Dict[str, Any]] = {}
        self.recorder_factory = recorder_factory or SessionRecorder
        self.base_dir = Path(base_dir or "storage").resolve()
        self.recordings_dir = self.base_dir / "recordings"
        self.schemas_dir = self.base_dir / "schemas"
        self.flowcharts_dir = self.base_dir / "flowcharts"
        self.automations_dir = self.base_dir / "automations"
        self.runs_dir = self.base_dir / "runs"
        self.recordings_dir.mkdir(parents=True, exist_ok=True)
        self.schemas_dir.mkdir(parents=True, exist_ok=True)
        self.flowcharts_dir.mkdir(parents=True, exist_ok=True)
        self.automations_dir.mkdir(parents=True, exist_ok=True)
        self.runs_dir.mkdir(parents=True, exist_ok=True)

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
        enriched = []
        for record in records:
            data = record.metadata.to_dict()
            chart_path = self.flowchart_path(record.metadata.session_id)
            data["flowchart_generated"] = chart_path.exists()
            enriched.append(data)
        return enriched

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

    def flowchart_path(self, session_id: str) -> Path:
        return (self.flowcharts_dir / f"{session_id}.json").resolve()

    def automation_path(self, automation_id: str) -> Path:
        return (self.automations_dir / f"{automation_id}.json").resolve()

    def run_path(self, run_id: str) -> Path:
        return (self.runs_dir / f"{run_id}.json").resolve()

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

    def save_flowchart(self, session_id: str, flowchart: Dict[str, Any]) -> None:
        record = self.get_session(session_id)
        record.flowchart = flowchart
        path = self.flowchart_path(session_id)
        with path.open("w", encoding="utf-8") as fh:
            json.dump(flowchart, fh, indent=2)

    def get_flowchart(self, session_id: str) -> Optional[Dict[str, Any]]:
        record = self.get_session(session_id)
        if record.flowchart is not None:
            return record.flowchart
        path = self.flowchart_path(session_id)
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        record.flowchart = data
        return data

    def list_automations(self) -> List[Dict[str, Any]]:
        if not self._automations:
            for path in self.automations_dir.glob("*.json"):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    continue
                automation_id = data.get("automation_id")
                if automation_id:
                    self._automations.setdefault(automation_id, data)
        items = sorted(self._automations.values(), key=lambda a: a.get("created_at", ""), reverse=True)
        return [dict(item) for item in items]

    def create_automation(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        automation_id = str(uuid4())
        timestamp = datetime.now(timezone.utc).isoformat()
        record = {
            "automation_id": automation_id,
            "created_at": timestamp,
            "updated_at": timestamp,
            **payload,
        }
        self._automations[automation_id] = record
        self._write_automation(record)
        return record

    def get_automation(self, automation_id: str) -> Dict[str, Any]:
        if automation_id in self._automations:
            return self._automations[automation_id]
        path = self.automation_path(automation_id)
        if not path.exists():
            raise KeyError(automation_id)
        data = json.loads(path.read_text(encoding="utf-8"))
        self._automations[automation_id] = data
        return data

    def list_runs(self, automation_id: Optional[str] = None) -> List[Dict[str, Any]]:
        if not self._runs:
            for path in self.runs_dir.glob('*.json'):
                try:
                    data = json.loads(path.read_text(encoding='utf-8'))
                except json.JSONDecodeError:
                    continue
                run_id = data.get('run_id')
                if run_id:
                    self._runs.setdefault(run_id, data)
        runs = list(self._runs.values())
        if automation_id is not None:
            runs = [run for run in runs if run.get('automation_id') == automation_id]
        runs.sort(key=lambda item: item.get('started_at') or item.get('created_at') or '', reverse=True)
        return [dict(run) for run in runs]

    def get_run(self, run_id: str) -> Dict[str, Any]:
        if run_id in self._runs:
            return self._runs[run_id]
        path = self.run_path(run_id)
        if not path.exists():
            raise KeyError(run_id)
        data = json.loads(path.read_text(encoding='utf-8'))
        self._runs[run_id] = data
        return data

    def run_automation(self, automation_id: str, *, engine: Optional[str] = None) -> Dict[str, Any]:
        automation = self.get_automation(automation_id)
        run_id = str(uuid4())
        timestamp = datetime.now(timezone.utc).isoformat()
        requested_engine = engine or automation.get("engine") or "deterministic"
        selected_engine = requested_engine.lower()
        if selected_engine not in {"deterministic", "llm", "hybrid"}:
            selected_engine = "deterministic"

        steps = automation.get("steps") or []
        normalised_modes = [(step.get("execution_mode") or "deterministic").lower() for step in steps]
        deterministic_count = sum(1 for mode in normalised_modes if mode == "deterministic")
        llm_count = sum(1 for mode in normalised_modes if mode == "llm")
        hybrid_count = sum(1 for mode in normalised_modes if mode == "hybrid")
        executed_steps = deterministic_count + llm_count + hybrid_count

        success = executed_steps > 0
        status = "succeeded" if success else "failed"
        target_url = automation.get("target_url")
        if not target_url and automation.get("session_id") in self._sessions:
            target_url = self._sessions[automation["session_id"]].metadata.url

        if success:
            message = f"Executed {executed_steps} steps using {selected_engine} engine."
        else:
            message = "Automation contains no executable steps; please add steps before running."

        log_entry = {
            "timestamp": timestamp,
            "level": "info",
            "message": message if success else "Run aborted because no steps were available.",
        }

        automation['updated_at'] = timestamp

        run_record = {
            "run_id": run_id,
            "automation_id": automation_id,
            "session_id": automation.get("session_id"),
            "engine": selected_engine,
            "status": status,
            "created_at": timestamp,
            "started_at": timestamp,
            "completed_at": timestamp,
            "target_url": target_url,
            "launch_url": target_url,
            "steps_planned": len(steps),
            "steps_executed": executed_steps if success else 0,
            "deterministic_steps": deterministic_count,
            "llm_steps": llm_count,
            "hybrid_steps": hybrid_count,
            "message": message,
            "logs": [log_entry],
            "result": {
                "success": success,
                "summary": message,
            },
        }

        self._runs[run_id] = run_record
        self._write_run(run_record)
        self._write_automation(automation)
        return run_record

    def _write_automation(self, record: Dict[str, Any]) -> None:
        path = self.automation_path(record["automation_id"])
        with path.open("w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2)

    def _write_run(self, record: Dict[str, Any]) -> None:
        path = self.run_path(record["run_id"])
        with path.open("w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2)
