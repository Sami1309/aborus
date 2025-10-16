"""Modeler service for recording browser sessions and synthesizing flow diagrams."""

from .events import ActionEvent, BrowserContext, DomSnapshot, FlowIntent
from .graph import FlowGraph, FlowNode
from .llm import FlowAnnotator, LlmClientConfig
from .recorder import SessionRecorder
from .session_manager import SessionManager

try:  # optional dependency: FastAPI + Pydantic
    from .service import ModelerService  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - optional import
    ModelerService = None  # type: ignore

__all__ = [
    "ActionEvent",
    "BrowserContext",
    "DomSnapshot",
    "FlowIntent",
    "FlowGraph",
    "FlowNode",
    "FlowAnnotator",
    "LlmClientConfig",
    "SessionRecorder",
    "SessionManager",
    "ModelerService",
]
