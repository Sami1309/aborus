"""FastAPI service exposing the modeler capabilities."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import HTMLResponse
    from fastapi.staticfiles import StaticFiles
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    FastAPI = None  # type: ignore
    HTMLResponse = None  # type: ignore
    StaticFiles = None  # type: ignore

    class HTTPException(Exception):  # type: ignore[override]
        def __init__(self, status_code: int, detail: str) -> None:
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

from pydantic import BaseModel, Field

from .events import FlowIntent
from .llm import FlowAnnotator
from .recorder import SessionRecorder
from .selectors import SelectorMiner
from .session_manager import SessionManager


class EventIn(BaseModel):
    payload: Dict[str, Any] = Field(default_factory=dict)

    class Config:
        arbitrary_types_allowed = True


class PatchIn(BaseModel):
    node_id: str
    selectors: Optional[list[str]] = None
    intent: Optional[Dict[str, Any]] = None
    session_id: Optional[str] = None


class SessionCreateIn(BaseModel):
    url: str


class SessionEventIn(BaseModel):
    payload: Dict[str, Any]


class ModelerService:
    """Encapsulates the FastAPI app and recording lifecycle."""

    def __init__(
        self,
        *,
        selector_miner: Optional[SelectorMiner] = None,
        annotator: Optional[FlowAnnotator] = None,
        session_manager: Optional[SessionManager] = None,
    ) -> None:
        if FastAPI is None:
            raise RuntimeError("FastAPI is required to build the ModelerService app")
        if session_manager is not None:
            self.sessions = session_manager
        else:
            def _factory() -> SessionRecorder:
                return SessionRecorder(selector_miner=selector_miner, annotator=annotator)

            self.sessions = SessionManager(recorder_factory=_factory)
        self._legacy_session_id: Optional[str] = None
        self.app = self._create_app()

    def _legacy_session(self) -> str:
        if self._legacy_session_id is None:
            metadata = self.sessions.create_session("legacy://session")
            self._legacy_session_id = metadata.session_id
        return self._legacy_session_id

    def _create_app(self) -> "FastAPI":
        app = FastAPI(title="Automation Modeler", version="0.2.0")

        web_root = Path(__file__).resolve().parents[2] / "web"
        if StaticFiles is not None and web_root.exists():
            app.mount("/web", StaticFiles(directory=str(web_root), html=True), name="modeler_web")

            dashboard = web_root / "dashboard" / "index.html"
            if dashboard.exists() and HTMLResponse is not None:
                @app.get("/", response_class=HTMLResponse)
                async def dashboard_root() -> HTMLResponse:  # type: ignore[valid-type]
                    return HTMLResponse(dashboard.read_text(encoding="utf-8"))

        @app.post("/sessions")
        async def create_session(body: SessionCreateIn) -> Dict[str, Any]:
            meta = self.sessions.create_session(body.url)
            session_id = meta.session_id
            return {
                "session": meta.to_dict(),
                "links": {
                    "schema": f"/sessions/{session_id}/schema",
                    "recording": f"/sessions/{session_id}/events",
                    "demo_page": f"/web/test-page.html?session={session_id}",
                },
            }

        @app.get("/sessions")
        async def list_sessions() -> Dict[str, Any]:
            sessions = []
            for meta in self.sessions.list_sessions():
                session_id = meta["session_id"]
                sessions.append(
                    {
                        **meta,
                        "links": {
                            "schema": f"/sessions/{session_id}/schema",
                            "recording": f"/sessions/{session_id}/events",
                            "demo_page": f"/web/test-page.html?session={session_id}",
                        },
                    }
                )
            return {"sessions": sessions}

        @app.get("/sessions/{session_id}")
        async def session_detail(session_id: str) -> Dict[str, Any]:
            try:
                record = self.sessions.get_session(session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            return {
                "session": record.metadata.to_dict(),
                "links": {
                    "schema": f"/sessions/{session_id}/schema",
                    "recording": f"/sessions/{session_id}/events",
                    "demo_page": f"/web/test-page.html?session={session_id}",
                },
                "graph": record.recorder.flow().to_dict(),
            }

        @app.post("/sessions/{session_id}/events")
        async def record_event(session_id: str, body: SessionEventIn) -> Dict[str, Any]:
            try:
                result = self.sessions.record_event(session_id, body.payload)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            return result

        @app.get("/sessions/{session_id}/schema")
        async def session_schema(session_id: str) -> Dict[str, Any]:
            try:
                path = self.sessions.schema_path(session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            if not path.exists():
                raise HTTPException(status_code=404, detail="Schema not found")
            return json.loads(path.read_text(encoding="utf-8"))

        @app.get("/sessions/{session_id}/events")
        async def session_events(session_id: str) -> Dict[str, Any]:
            try:
                path = self.sessions.recording_path(session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            if not path.exists():
                raise HTTPException(status_code=404, detail="Recording not found")
            return {
                "session_id": session_id,
                "events": json.loads(path.read_text(encoding="utf-8")),
            }

        @app.post("/events")
        async def ingest(event_in: EventIn) -> Dict[str, Any]:
            session_id = self._legacy_session()
            return self.sessions.record_event(session_id, event_in.payload)

        @app.get("/flow")
        async def flow() -> Dict[str, Any]:
            session_id = self._legacy_session()
            record = self.sessions.get_session(session_id)
            return record.recorder.flow().to_dict()

        @app.post("/flow/patch")
        async def patch(patch_in: PatchIn) -> Dict[str, Any]:
            session_id = patch_in.session_id or self._legacy_session()
            try:
                graph = self.sessions.get_session(session_id).recorder.flow()
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            node = graph.get(patch_in.node_id)
            if not node:
                raise HTTPException(status_code=404, detail="Node not found")
            if patch_in.selectors is not None:
                graph.update_node(patch_in.node_id, selectors=patch_in.selectors)
            if patch_in.intent is not None:
                graph.update_node(
                    patch_in.node_id,
                    intent=FlowIntent(
                        summary=patch_in.intent.get("summary", node.intent.summary),
                        semantic_action=patch_in.intent.get("semantic_action", node.intent.semantic_action),
                        user_value=patch_in.intent.get("user_value", node.intent.user_value),
                        confidence=float(patch_in.intent.get("confidence", node.intent.confidence)),
                    ),
                )
            # Persist mutations
            self.sessions.persist_schema(session_id)
            return {"graph": graph.to_dict()}

        return app
