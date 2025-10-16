import json
import tempfile
from pathlib import Path

from agent.modeler.session_manager import SessionManager

SAMPLE_EVENT = {
    "event_id": "evt-abc",
    "timestamp": "2024-07-18T12:34:56",
    "category": "click",
    "url": "https://example.com",
    "dom": {
        "tag": "button",
        "attributes": {
            "id": "start",
            "role": "button",
        },
        "innerText": "Start",
        "classList": ["cta"],
        "cssPath": "button#start",
    },
    "payload": {
        "selector": "button#start",
    },
}


def test_session_manager_records_and_persists():
    with tempfile.TemporaryDirectory() as tmpdir:
        base_dir = Path(tmpdir)
        manager = SessionManager(base_dir=base_dir)
        session = manager.create_session("https://example.com")

        result = manager.record_event(session.session_id, SAMPLE_EVENT)
        assert "graph" in result
        assert manager.schema_path(session.session_id).exists()
        assert manager.recording_path(session.session_id).exists()

        schema = json.loads(manager.schema_path(session.session_id).read_text())
        assert schema["nodes"]

        events = json.loads(manager.recording_path(session.session_id).read_text())
        assert len(events) == 1
        assert events[0]["payload"]["selector"] == "button#start"
