import unittest

from agent.modeler.llm import FlowChartGenerator, _loads_best_effort


class LlmParsingTests(unittest.TestCase):
    def test_loads_best_effort_handles_fenced_json(self) -> None:
        content = "Result follows:\n```json\n{\"steps\": []}\n```"
        parsed = _loads_best_effort(content)
        self.assertIsInstance(parsed, dict)
        self.assertEqual(parsed.get("steps"), [])

    def test_flowchart_generator_parses_fenced_json(self) -> None:
        generator = FlowChartGenerator()
        baseline_nodes = [
            {
                "node_id": "evt-1",
                "order": 1,
                "intent_summary": "Click submit",
                "action_type": "click",
                "selectors": ["button#submit"],
                "semantic_action": None,
                "user_value": None,
                "confidence": 0.9,
            }
        ]
        response = {
            "content": [
                {
                    "type": "text",
                    "text": "Here is the flow chart:\n```json\n{\n  \"steps\": [\n    {\n      \"node_id\": \"evt-1\",\n      \"title\": \"Submit Order\",\n      \"description\": \"Click the primary submit button to place the order.\",\n      \"execution_mode\": \"deterministic\",\n      \"dom_selectors\": [\"button#submit\"],\n      \"hints\": {}\n    }\n  ]\n}\n```\n",
                }
            ]
        }

        steps = generator._parse_response(response, baseline_nodes)
        self.assertEqual(len(steps), 1)
        step = steps[0]
        self.assertEqual(step["node_id"], "evt-1")
        self.assertEqual(step["title"], "Submit Order")
        self.assertEqual(step["execution_mode"], "deterministic")
        self.assertEqual(step["dom_selectors"], ["button#submit"])


if __name__ == "__main__":
    unittest.main()
