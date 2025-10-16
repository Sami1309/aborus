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


def test_session_manager_flowchart_and_automation():
    with tempfile.TemporaryDirectory() as tmpdir:
        base_dir = Path(tmpdir)
        manager = SessionManager(base_dir=base_dir)
        session = manager.create_session("https://example.com")
        manager.record_event(session.session_id, SAMPLE_EVENT)

        flowchart = {
            "session_id": session.session_id,
            "generated_at": "2024-01-01T00:00:00Z",
            "model": "claude-test",
            "steps": [
                {
                    "node_id": SAMPLE_EVENT["event_id"],
                    "order": 1,
                    "title": "Click submit",
                    "description": "click submit",
                    "execution_mode": "deterministic",
                    "dom_selectors": ["button#start"],
                    "hints": {},
                }
            ],
            "edges": {},
            "source": {"type": "heuristic"},
        }

        manager.save_flowchart(session.session_id, flowchart)
        loaded = manager.get_flowchart(session.session_id)
        assert loaded == flowchart

        automation = manager.create_automation(
            {
                "session_id": session.session_id,
                "name": "Smoke",
                "engine": "hybrid",
                "description": "",
                "steps": flowchart["steps"],
                "flowchart_snapshot": flowchart,
            }
        )
        assert automation["automation_id"]
        listed = manager.list_automations()
        assert any(item["automation_id"] == automation["automation_id"] for item in listed)

        run_result = manager.run_automation(automation["automation_id"], engine="llm")
        assert run_result["status"] == "succeeded"
        assert run_result["engine"] == "llm"
        assert run_result["launch_url"] == "https://example.com"
        assert run_result["steps_executed"] == 1

        runs = manager.list_runs(automation_id=automation["automation_id"])
        assert any(item["run_id"] == run_result["run_id"] for item in runs)
        stored_run = manager.get_run(run_result["run_id"])
        assert stored_run["status"] == "succeeded"
