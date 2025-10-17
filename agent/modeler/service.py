"""FastAPI service exposing the modeler capabilities."""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from fastapi import FastAPI, HTTPException, Request
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
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from .config import ServerResourceLimits
from .events import FlowIntent
from .llm import FlowAnnotator, FlowChartGenerator, FlowChartEditor
from .recorder import SessionRecorder
from .selectors import SelectorMiner
from .session_manager import SessionManager

try:
    from .browser_executor import BrowserUseExecutor, BROWSER_USE_AVAILABLE
except ImportError:
    BROWSER_USE_AVAILABLE = False
    BrowserUseExecutor = None  # type: ignore


logger = logging.getLogger(__name__)


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


class FlowchartGenerateIn(BaseModel):
    regenerate: bool = False


class FlowchartEditIn(BaseModel):
    instructions: str


class AutomationNodeIn(BaseModel):
    node_id: str
    execution_mode: str = Field(default="deterministic")
    dom_selectors: List[str] = Field(default_factory=list)
    title: Optional[str] = None
    description: Optional[str] = None
    hints: Optional[Dict[str, Any]] = None


class AutomationCreateIn(BaseModel):
    session_id: str
    name: str
    engine: str = Field(default="deterministic")
    description: Optional[str] = None
    steps: List[AutomationNodeIn]
    flowchart_snapshot: Optional[Dict[str, Any]] = None


class AutomationRunIn(BaseModel):
    engine: Optional[str] = None


class RunProgressIn(BaseModel):
    step_index: int
    status: str
    message: Optional[str] = None
    details: Optional[Dict[str, Any]] = None


class LLMStepExecuteIn(BaseModel):
    step: Dict[str, Any]
    context: Optional[Dict[str, Any]] = None


class ModelerService:
    """Encapsulates the FastAPI app and recording lifecycle."""

    def __init__(
        self,
        *,
        selector_miner: Optional[SelectorMiner] = None,
        annotator: Optional[FlowAnnotator] = None,
        session_manager: Optional[SessionManager] = None,
        flowchart_generator: Optional[FlowChartGenerator] = None,
        flowchart_editor: Optional[FlowChartEditor] = None,
        resource_limits: Optional[ServerResourceLimits] = None,
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
        flowchart_config = annotator.config if annotator else None
        self.flowchart_generator = flowchart_generator or FlowChartGenerator(config=flowchart_config)
        self.flowchart_editor = flowchart_editor or FlowChartEditor(config=self.flowchart_generator.config)
        self.resource_limits = resource_limits or ServerResourceLimits()
        self._executor: Optional[concurrent.futures.Executor] = None
        self.app = self._create_app()

    def _legacy_session(self) -> str:
        if self._legacy_session_id is None:
            metadata = self.sessions.create_session("legacy://session")
            self._legacy_session_id = metadata.session_id
        return self._legacy_session_id

    def _create_app(self) -> "FastAPI":
        app = FastAPI(title="Automation Modeler", version="0.2.0")

        if self.resource_limits.threadpool_workers:
            max_workers = max(1, self.resource_limits.threadpool_workers)

            @app.on_event("startup")
            async def _configure_executor() -> None:
                loop = asyncio.get_running_loop()
                executor = concurrent.futures.ThreadPoolExecutor(
                    max_workers=max_workers,
                    thread_name_prefix="modeler-worker",
                )
                loop.set_default_executor(executor)
                self._executor = executor

            @app.on_event("shutdown")
            async def _shutdown_executor() -> None:
                if self._executor:
                    self._executor.shutdown(wait=False)
                    self._executor = None

        web_root = Path(__file__).resolve().parents[2] / "web"
        if StaticFiles is not None and web_root.exists():
            app.mount("/web", StaticFiles(directory=str(web_root), html=True), name="modeler_web")

            dashboard = web_root / "dashboard" / "index.html"
            if dashboard.exists() and HTMLResponse is not None:
                @app.get("/", response_class=HTMLResponse)
                async def dashboard_root() -> HTMLResponse:  # type: ignore[valid-type]
                    return HTMLResponse(dashboard.read_text(encoding="utf-8"))

        @app.post("/sessions")
        async def create_session(body: SessionCreateIn, request: "Request") -> Dict[str, Any]:
            meta = self.sessions.create_session(body.url)
            session_id = meta.session_id
            api_base = str(request.base_url).rstrip("/")
            recording_page = self._build_recording_url(body.url, session_id, api_base)
            return {
                "session": meta.to_dict(),
                "links": {
                    "schema": f"/sessions/{session_id}/schema",
                    "recording": f"/sessions/{session_id}/events",
                    "demo_page": f"/web/test-page.html?session={session_id}",
                    "recording_page": recording_page,
                    "flowchart": f"/sessions/{session_id}/flowchart",
                },
            }

        @app.get("/sessions")
        async def list_sessions(request: "Request") -> Dict[str, Any]:
            sessions = []
            api_base = str(request.base_url).rstrip("/")
            for meta in self.sessions.list_sessions():
                session_id = meta["session_id"]
                target_url = meta.get("url")
                recording_page = self._build_recording_url(target_url, session_id, api_base) if target_url else None
                sessions.append(
                    {
                        **meta,
                        "flowchart_generated": meta.get("flowchart_generated", False),
                        "links": {
                            "schema": f"/sessions/{session_id}/schema",
                            "recording": f"/sessions/{session_id}/events",
                            "demo_page": f"/web/test-page.html?session={session_id}",
                            "recording_page": recording_page,
                            "flowchart": f"/sessions/{session_id}/flowchart",
                        },
                    }
                )
            return {"sessions": sessions}

        @app.get("/sessions/{session_id}")
        async def session_detail(session_id: str, request: "Request") -> Dict[str, Any]:
            try:
                record = self.sessions.get_session(session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            api_base = str(request.base_url).rstrip("/")
            target_url = record.metadata.url
            recording_page = self._build_recording_url(target_url, session_id, api_base)
            # Serve graph from memory for instant access
            return {
                "session": record.metadata.to_dict(),
                "links": {
                    "schema": f"/sessions/{session_id}/schema",
                    "recording": f"/sessions/{session_id}/events",
                    "demo_page": f"/web/test-page.html?session={session_id}",
                    "recording_page": recording_page,
                    "flowchart": f"/sessions/{session_id}/flowchart",
                },
                "graph": record.recorder.flow().to_dict(),
                "flowchart_generated": self.sessions.flowchart_path(session_id).exists(),
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
                record = self.sessions.get_session(session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            # Serve schema from memory instead of disk for instant access
            return record.recorder.flow().to_dict()

        @app.get("/sessions/{session_id}/events")
        async def session_events(session_id: str) -> Dict[str, Any]:
            try:
                record = self.sessions.get_session(session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            # Serve events from memory for better performance
            return {
                "session_id": session_id,
                "events": record.events,
            }

        @app.get("/sessions/{session_id}/flowchart")
        async def session_flowchart(session_id: str) -> Dict[str, Any]:
            try:
                flowchart = self.sessions.get_flowchart(session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            if flowchart is None:
                raise HTTPException(status_code=404, detail="Flow chart not found")
            return flowchart

        @app.post("/sessions/{session_id}/flowchart")
        async def generate_flowchart(session_id: str, body: Optional[FlowchartGenerateIn] = None) -> Dict[str, Any]:
            try:
                record = self.sessions.get_session(session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            existing = self.sessions.get_flowchart(session_id)
            if existing and not (body and body.regenerate):
                return existing
            # Persist schema before flowchart generation
            self.sessions.persist_schema(session_id)
            chart = self.flowchart_generator.generate(session_id, record.recorder.flow())
            self.sessions.save_flowchart(session_id, chart)
            return chart

        @app.post("/sessions/{session_id}/flowchart/edit")
        async def edit_flowchart(session_id: str, body: FlowchartEditIn) -> Dict[str, Any]:
            try:
                flowchart = self.sessions.get_flowchart(session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            if flowchart is None:
                raise HTTPException(status_code=404, detail="Flow chart not found")
            instructions = (body.instructions or '').strip()
            if not instructions:
                raise HTTPException(status_code=400, detail="Instructions are required")
            try:
                updated = self.flowchart_editor.edit(flowchart, instructions)
            except ValueError as err:
                raise HTTPException(status_code=400, detail=str(err))
            except RuntimeError as err:
                logger.exception("Flow chart edit runtime failure for session %s", session_id)
                raise HTTPException(status_code=503, detail=str(err))
            self.sessions.save_flowchart(session_id, updated)
            return updated

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

        @app.get("/automations")
        async def list_automations_endpoint() -> Dict[str, Any]:
            automations = self.sessions.list_automations()
            return {"automations": automations}

        @app.post("/automations")
        async def create_automation_endpoint(body: AutomationCreateIn) -> Dict[str, Any]:
            try:
                session_record = self.sessions.get_session(body.session_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Session not found")
            # Persist schema before automation creation
            self.sessions.persist_schema(body.session_id)
            automation = self.sessions.create_automation(
                {
                    "session_id": body.session_id,
                    "name": body.name,
                    "engine": body.engine,
                    "description": body.description,
                    "steps": [step.dict() for step in body.steps],
                    "flowchart_snapshot": body.flowchart_snapshot,
                    "target_url": session_record.metadata.url,
                    "session_created_at": session_record.metadata.created_at.isoformat(),
                }
            )
            return {"automation": automation}

        @app.get("/automations/{automation_id}")
        async def automation_detail(automation_id: str) -> Dict[str, Any]:
            try:
                automation = self.sessions.get_automation(automation_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Automation not found")
            return {"automation": automation}

        @app.get("/automations/{automation_id}/runs")
        async def automation_runs_endpoint(automation_id: str) -> Dict[str, Any]:
            try:
                self.sessions.get_automation(automation_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Automation not found")
            runs = self.sessions.list_runs(automation_id=automation_id)
            return {'runs': runs}

        @app.get("/runs")
        async def runs_index() -> Dict[str, Any]:
            return {'runs': self.sessions.list_runs()}

        @app.get("/runs/{run_id}")
        async def run_detail_endpoint(run_id: str) -> Dict[str, Any]:
            try:
                run = self.sessions.get_run(run_id)
            except KeyError:
                raise HTTPException(status_code=404, detail="Run not found")
            return {'run': run}

        @app.post("/automations/{automation_id}/run")
        async def run_automation_endpoint(automation_id: str, body: Optional[AutomationRunIn] = None) -> Dict[str, Any]:
            try:
                result = self.sessions.run_automation(automation_id, engine=body.engine if body else None)
            except KeyError:
                raise HTTPException(status_code=404, detail="Automation not found")
            return result

        @app.post("/runs/{run_id}/progress")
        async def run_progress_endpoint(run_id: str, body: RunProgressIn) -> Dict[str, Any]:
            try:
                updated = self.sessions.update_run_progress(
                    run_id,
                    step_index=body.step_index,
                    status=body.status,
                    message=body.message,
                    details=body.details,
                )
            except KeyError:
                raise HTTPException(status_code=404, detail="Run not found")
            except IndexError as error:
                raise HTTPException(status_code=400, detail=str(error))
            return {'run': updated}

        @app.post("/execute/llm-step")
        async def execute_llm_step_endpoint(body: LLMStepExecuteIn) -> Dict[str, Any]:
            """Execute a single automation step using browser-use LLM agent."""
            if not BROWSER_USE_AVAILABLE:
                raise HTTPException(
                    status_code=501,
                    detail="Browser-use is not available. Install with: uv pip install browser-use langchain-anthropic"
                )

            try:
                executor = BrowserUseExecutor()
                result = await executor.execute_step(body.step, body.context)
                return {"result": result}
            except ValueError as error:
                raise HTTPException(status_code=400, detail=str(error))
            except Exception as error:
                logger.exception("LLM step execution failed")
                raise HTTPException(status_code=500, detail=str(error))

        return app

    @staticmethod
    def _build_recording_url(target_url: Optional[str], session_id: str, api_base: Optional[str]) -> Optional[str]:
        if not target_url:
            return None
        try:
            parsed = urlparse(target_url)
        except Exception:
            return target_url

        query = parse_qs(parsed.query, keep_blank_values=True)
        query["session"] = [session_id]
        if api_base:
            query["modeler_origin"] = [api_base]

        encoded_query = urlencode(query, doseq=True)
        return urlunparse(parsed._replace(query=encoded_query))
