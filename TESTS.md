# Testing Guide

This guide covers running and writing tests for the AB Automate Modeler project.

## Overview

The project uses Python's `unittest` framework with FastAPI's `TestClient` for testing the `/events` API and other modeler functionality. Tests verify:
- Session recording and flow graph generation
- API endpoints for event ingestion and flow patching
- CLI flow export functionality

## Prerequisites

### Install Dependencies

```bash
# Create virtual environment (if not already created)
uv venv

# Install required testing packages
uv pip install pytest httpx fastapi pydantic uvicorn
```

### Dependencies
- **pytest**: Test runner
- **httpx**: Required by FastAPI TestClient
- **fastapi**: Web framework for the modeler service
- **pydantic**: Data validation
- **uvicorn**: ASGI server (for production use)

## Running Tests

### Run All Tests

```bash
# Activate virtual environment
source .venv/bin/activate

# Run tests with pytest
python -m pytest tests/test_modeler.py -v
```

### Run Specific Test Classes

```bash
# Run only SessionRecorder tests
python -m pytest tests/test_modeler.py::SessionRecorderTests -v

# Run only ModelerService API tests
python -m pytest tests/test_modeler.py::ModelerServiceTests -v

# Run only CLI export tests
python -m pytest tests/test_modeler.py::CliFlowExportTests -v
```

### Run Specific Test Methods

```bash
python -m pytest tests/test_modeler.py::ModelerServiceTests::test_modeler_service_patch_updates_selectors -v
```

### Using unittest directly

```bash
# Run all tests
python -m unittest tests/test_modeler.py

# Run specific test class
python -m unittest tests.test_modeler.SessionRecorderTests

# Run specific test method
python -m unittest tests.test_modeler.ModelerServiceTests.test_modeler_service_patch_updates_selectors
```

## Test Structure

### Test Files

Tests are located in `tests/test_modeler.py`. The file contains three test classes:

1. **SessionRecorderTests** - Tests the core recording functionality
2. **ModelerServiceTests** - Tests the FastAPI service and `/events` API
3. **CliFlowExportTests** - Tests CLI export functionality

### Sample Event Format

Tests use a standard browser event format:

```python
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
```

## Writing Tests for the /events API

### Basic API Test Structure

```python
import unittest
from fastapi.testclient import TestClient
from agent.modeler.service import ModelerService

class MyAPITests(unittest.TestCase):
    def test_endpoint(self):
        # 1. Create service instance
        service = ModelerService()

        # 2. Create test client
        client = TestClient(service.app)

        # 3. Make API request
        response = client.post("/events", json={"payload": event_data})

        # 4. Assert response
        self.assertEqual(response.status_code, 200)
        self.assertIn("graph", response.json())
```

### Testing /events Endpoint

The `/events` endpoint ingests browser events and returns the created node and updated flow graph:

```python
def test_events_endpoint(self):
    service = ModelerService()
    client = TestClient(service.app)

    event = {
        "event_id": "test-1",
        "category": "click",
        "dom": {"tag": "button", "cssPath": "#submit"},
        "payload": {"selector": "#submit"}
    }

    response = client.post("/events", json={"payload": event})

    # Check response structure
    self.assertEqual(response.status_code, 200)
    data = response.json()
    self.assertIn("node", data)
    self.assertIn("graph", data)

    # Check graph contains the node
    graph = data["graph"]
    node_id = data["node"]["event_id"]
    self.assertIn(node_id, graph["nodes"])
```

### Testing /flow Endpoint

The `/flow` endpoint returns the current flow graph:

```python
def test_flow_endpoint(self):
    service = ModelerService()
    client = TestClient(service.app)

    # First, add an event
    client.post("/events", json={"payload": SAMPLE_EVENT})

    # Then get the flow
    response = client.get("/flow")

    self.assertEqual(response.status_code, 200)
    graph = response.json()
    self.assertIn("nodes", graph)
    self.assertIn("entry", graph)
```

### Testing /flow/patch Endpoint

The `/flow/patch` endpoint updates node selectors or intent:

```python
def test_patch_selectors(self):
    service = ModelerService()
    client = TestClient(service.app)

    # Add an event
    response = client.post("/events", json={"payload": SAMPLE_EVENT})
    node_id = response.json()["node"]["event_id"]

    # Patch the node
    patch_response = client.post(
        "/flow/patch",
        json={"node_id": node_id, "selectors": ["#new-selector"]}
    )

    self.assertEqual(patch_response.status_code, 200)
    graph = patch_response.json()["graph"]
    self.assertEqual(
        graph["nodes"][node_id]["selectors"],
        ["#new-selector"]
    )
```

### Testing Intent Updates

```python
def test_patch_intent(self):
    service = ModelerService()
    client = TestClient(service.app)

    # Add an event
    response = client.post("/events", json={"payload": SAMPLE_EVENT})
    node_id = response.json()["node"]["event_id"]

    # Update intent
    new_intent = {
        "summary": "Custom action",
        "semantic_action": "submit_form",
        "user_value": "critical",
        "confidence": 0.95
    }

    patch_response = client.post(
        "/flow/patch",
        json={"node_id": node_id, "intent": new_intent}
    )

    self.assertEqual(patch_response.status_code, 200)
    graph = patch_response.json()["graph"]
    intent = graph["nodes"][node_id]["intent"]
    self.assertEqual(intent["summary"], "Custom action")
```

## API Endpoints Reference

### POST /events

Ingest a browser event and update the flow graph.

**Request:**
```json
{
  "payload": {
    "event_id": "evt-1",
    "category": "click",
    "dom": { ... },
    "payload": { ... }
  }
}
```

**Response:**
```json
{
  "node": { ... },
  "graph": {
    "nodes": { ... },
    "entry": "evt-1"
  }
}
```

### GET /flow

Get the current flow graph.

**Response:**
```json
{
  "nodes": { ... },
  "entry": "evt-1"
}
```

### POST /flow/patch

Update a node's selectors or intent.

**Request:**
```json
{
  "node_id": "evt-1",
  "selectors": ["#new-selector"],
  "intent": {
    "summary": "Click submit",
    "semantic_action": "click",
    "user_value": "value",
    "confidence": 0.9
  }
}
```

**Response:**
```json
{
  "graph": { ... }
}
```

## Best Practices

1. **Use TestClient**: Always use FastAPI's `TestClient` for API testing
2. **Isolate Tests**: Each test should create its own `ModelerService` instance
3. **Test Edge Cases**: Test invalid node IDs, missing fields, etc.
4. **Verify Graph State**: Check that the graph is updated correctly after operations
5. **Use Descriptive Names**: Name tests clearly (e.g., `test_patch_updates_selectors`)
6. **Skip Conditionally**: Use `@unittest.skipIf` for tests requiring optional dependencies

## Example: Complete Test Case

```python
import unittest
from fastapi.testclient import TestClient
from agent.modeler.service import ModelerService

class NewFeatureTests(unittest.TestCase):
    def setUp(self):
        """Create service and client for each test."""
        self.service = ModelerService()
        self.client = TestClient(self.service.app)

    def test_multiple_events_create_sequence(self):
        """Test that multiple events create a proper sequence."""
        # Add first event
        event1 = {
            "event_id": "evt-1",
            "category": "click",
            "dom": {"tag": "button", "cssPath": "#start"}
        }
        self.client.post("/events", json={"payload": event1})

        # Add second event
        event2 = {
            "event_id": "evt-2",
            "category": "input",
            "dom": {"tag": "input", "cssPath": "#email"}
        }
        self.client.post("/events", json={"payload": event2})

        # Get flow and verify
        response = self.client.get("/flow")
        graph = response.json()

        self.assertEqual(len(graph["nodes"]), 2)
        self.assertIn("evt-1", graph["nodes"])
        self.assertIn("evt-2", graph["nodes"])
```

## Troubleshooting

### ModuleNotFoundError: No module named 'httpx'

Install httpx: `uv pip install httpx`

### RuntimeError: FastAPI is required

Install FastAPI: `uv pip install fastapi`

### Tests are skipped

Some tests use `@unittest.skipIf` to skip when dependencies are missing. Install all dependencies to run all tests.

## Current Test Results

All tests passing:
- `test_session_recorder_builds_flow_graph` - PASSED
- `test_modeler_service_patch_updates_selectors` - PASSED
- `test_export_flow_outputs_json` - PASSED

Note: There's a Pydantic deprecation warning in `agent/modeler/service.py:26` that should be addressed by migrating from `class Config` to `ConfigDict`.
