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
