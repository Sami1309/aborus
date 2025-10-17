import json
import unittest

try:
    from fastapi.testclient import TestClient
except ModuleNotFoundError:
    TestClient = None  # type: ignore

from agent.modeler.recorder import SessionRecorder
try:
    from agent.modeler.service import ModelerService
except (ModuleNotFoundError, RuntimeError):
    ModelerService = None  # type: ignore


SAMPLE_EVENT = {
    "event_id": "evt-1",
    "timestamp": "2024-07-18T12:00:10",
    "category": "click",
    "url": "https://example.com",
    "dom": {
        "tag": "button",
        "attributes": {
            "id": "submit",
            "role": "button",
        },
        "accessibleName": "Submit order",
        "innerText": "Submit",
        "classList": ["cta", "primary"],
        "cssPath": "button#submit",
    },
    "payload": {
        "selector": "button#submit",
    },
}


class SessionRecorderTests(unittest.TestCase):
    def test_session_recorder_builds_flow_graph(self) -> None:
        recorder = SessionRecorder()
        node = recorder.record_browser_use_event(SAMPLE_EVENT)
        self.assertTrue(node.intent.summary.startswith("click"))
        graph = recorder.flow()
        self.assertEqual(len(graph), 1)
        stored_node = graph.get("evt-1")
        self.assertIsNotNone(stored_node)
        self.assertEqual(stored_node.selectors[0], "button#submit")


class ModelerServiceTests(unittest.TestCase):
    @unittest.skipIf(TestClient is None or ModelerService is None, "FastAPI stack not available")
    def test_flowchart_edit_endpoint_preserves_steps(self) -> None:
        service = ModelerService()
        client = TestClient(service.app)

        create_response = client.post("/sessions", json={"url": "https://example.com"})
        self.assertEqual(create_response.status_code, 200)
        session_id = create_response.json()["session"]["session_id"]
        links = create_response.json().get("links", {})
        self.assertIn("recording_page", links)
        self.assertTrue(links["recording_page"].startswith("https://example.com"))
        self.assertIn("session=", links["recording_page"])

        record_response = client.post(f"/sessions/{session_id}/events", json={"payload": SAMPLE_EVENT})
        self.assertEqual(record_response.status_code, 200)

        flowchart_response = client.post(
            f"/sessions/{session_id}/flowchart",
            json={"regenerate": True},
        )
        self.assertEqual(flowchart_response.status_code, 200)
        flowchart = flowchart_response.json()
        original_steps = flowchart.get("steps", [])
        self.assertTrue(original_steps)

        edit_response = client.post(
            f"/sessions/{session_id}/flowchart/edit",
            json={"instructions": "Add a note describing the outcome."},
        )
        self.assertEqual(edit_response.status_code, 200)
        edited = edit_response.json()
        self.assertEqual(edited["session_id"], session_id)
        self.assertIn("steps", edited)
        self.assertEqual(len(edited["steps"]), len(original_steps))
        self.assertIn("history", edited)
        self.assertTrue(edited["history"])
        last_entry = edited["history"][-1]
        self.assertEqual(last_entry.get("instructions"), "Add a note describing the outcome.")
        self.assertEqual(edited.get("source", {}).get("operation"), "edit")

        missing_instructions = client.post(
            f"/sessions/{session_id}/flowchart/edit",
            json={"instructions": ""},
        )
        self.assertEqual(missing_instructions.status_code, 400)

    @unittest.skipIf(TestClient is None or ModelerService is None, "FastAPI stack not available")
    def test_modeler_service_patch_updates_selectors(self) -> None:
        service = ModelerService()
        client = TestClient(service.app)

        response = client.post("/events", json={"payload": SAMPLE_EVENT})
        self.assertEqual(response.status_code, 200)
        graph = response.json()["graph"]
        node_id = graph["entry"]

        patch_response = client.post(
            "/flow/patch",
            json={"node_id": node_id, "selectors": ["#submit"]},
        )
        self.assertEqual(patch_response.status_code, 200)
        mutated_graph = patch_response.json()["graph"]
        self.assertEqual(mutated_graph["nodes"][node_id]["selectors"], ["#submit"])

    @unittest.skipIf(TestClient is None or ModelerService is None, "FastAPI stack not available")
    def test_flowchart_generation_and_automation_pipeline(self) -> None:
        service = ModelerService()
        client = TestClient(service.app)

        create_response = client.post("/sessions", json={"url": "https://example.com"})
        self.assertEqual(create_response.status_code, 200)
        session_id = create_response.json()["session"]["session_id"]
        recording_link = create_response.json().get("links", {}).get("recording_page")
        self.assertIsNotNone(recording_link)
        self.assertTrue(recording_link.startswith("https://example.com"))

        record_response = client.post(f"/sessions/{session_id}/events", json={"payload": SAMPLE_EVENT})
        self.assertEqual(record_response.status_code, 200)

        flowchart_response = client.post(
            f"/sessions/{session_id}/flowchart",
            json={"regenerate": True},
        )
        self.assertEqual(flowchart_response.status_code, 200)
        flowchart = flowchart_response.json()
        self.assertEqual(flowchart["session_id"], session_id)
        self.assertTrue(flowchart["steps"])

        automation_payload = {
            "session_id": session_id,
            "name": "Smoke path",
            "engine": "hybrid",
            "steps": [
                {
                    "node_id": step["node_id"],
                    "execution_mode": step.get("execution_mode", "deterministic"),
                    "dom_selectors": step.get("dom_selectors", []),
                    "title": step.get("title"),
                    "description": step.get("description"),
                    "hints": step.get("hints", {}),
                }
                for step in flowchart["steps"]
            ],
            "flowchart_snapshot": flowchart,
        }

        automation_response = client.post("/automations", json=automation_payload)
        self.assertEqual(automation_response.status_code, 200)
        automation_id = automation_response.json()["automation"]["automation_id"]

        run_response = client.post(
            f"/automations/{automation_id}/run",
            json={"engine": "llm"},
        )
        self.assertEqual(run_response.status_code, 200)
        run_data = run_response.json()
        self.assertEqual(run_data["status"], "running")
        self.assertEqual(run_data["engine"], "llm")
        self.assertTrue(run_data.get("launch_url", "").startswith("https://example.com"))
        self.assertEqual(run_data.get("steps_executed"), 0)
        self.assertEqual(run_data.get("automation_name"), "Smoke path")
        self.assertIn("run_id", run_data)

        # simulate automation progress via API
        run_id = run_data["run_id"]
        progress_start = client.post(
            f"/runs/{run_id}/progress",
            json={
                "step_index": 0,
                "status": "started",
                "message": "Step started",
            },
        )
        self.assertEqual(progress_start.status_code, 200)

        progress_finish = client.post(
            f"/runs/{run_id}/progress",
            json={
                "step_index": 0,
                "status": "succeeded",
                "message": "Step done",
            },
        )
        self.assertEqual(progress_finish.status_code, 200)

        completion = client.post(
            f"/runs/{run_id}/progress",
            json={
                "step_index": 0,
                "status": "completed",
                "message": "Automation finished",
            },
        )
        self.assertEqual(completion.status_code, 200)
        self.assertEqual(completion.json()["run"]["status"], "succeeded")

        runs_response = client.get("/runs")
        self.assertEqual(runs_response.status_code, 200)
        runs_payload = runs_response.json()
        run_ids = {item["run_id"] for item in runs_payload.get("runs", [])}
        self.assertIn(run_id, run_ids)

        automation_runs = client.get(f"/automations/{automation_id}/runs")
        self.assertEqual(automation_runs.status_code, 200)
        automation_run_ids = {item["run_id"] for item in automation_runs.json().get("runs", [])}
        self.assertIn(run_id, automation_run_ids)

        run_detail = client.get(f"/runs/{run_id}")
        self.assertEqual(run_detail.status_code, 200)
        self.assertEqual(run_detail.json()["run"]["run_id"], run_id)


class CliFlowExportTests(unittest.TestCase):
    def test_export_flow_outputs_json(self) -> None:
        from agent.modeler.cli import export_flow

        recorder_events = [SAMPLE_EVENT]
        from io import StringIO
        import sys

        buffer = StringIO()
        original_stdout = sys.stdout
        try:
            sys.stdout = buffer
            export_flow(recorder_events, out_path=None)
        finally:
            sys.stdout = original_stdout
        payload = json.loads(buffer.getvalue())
        self.assertIn("nodes", payload)
        self.assertEqual(len(payload["nodes"]), 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
