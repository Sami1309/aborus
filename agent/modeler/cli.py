"""Command-line helpers for the modeler."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable

from .recorder import SessionRecorder
from .config import load_server_resource_limits


def _load_events(paths: Iterable[Path]) -> list[dict]:
    events: list[dict] = []
    for path in paths:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
            if isinstance(data, list):
                events.extend(data)
            else:
                events.append(data)
    return events


def export_flow(events: list[dict], out_path: Path | None) -> None:
    recorder = SessionRecorder()
    for raw in events:
        recorder.record_browser_use_event(raw)
    serialized = recorder.flow().to_dict()
    if out_path:
        out_path.write_text(json.dumps(serialized, indent=2), encoding="utf-8")
    else:
        json.dump(serialized, sys.stdout, indent=2)
        sys.stdout.write("\n")


def serve(host: str, port: int) -> None:
    try:
        import uvicorn  # type: ignore
    except ModuleNotFoundError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError("uvicorn is required to run the API server") from exc

    try:
        from .service import ModelerService
    except ModuleNotFoundError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError("FastAPI + Pydantic are required to run the API server") from exc

    limits = load_server_resource_limits()
    service = ModelerService(resource_limits=limits)
    uvicorn_kwargs = limits.merge_uvicorn_kwargs({})
    uvicorn_kwargs = {key: value for key, value in uvicorn_kwargs.items() if value is not None}
    uvicorn.run(service.app, host=host, port=port, **uvicorn_kwargs)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Automation stack modeler utilities")
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export", help="Export a flow graph from recorded events")
    export_parser.add_argument("paths", nargs="+", type=Path, help="Path(s) to JSON event files")
    export_parser.add_argument("--out", type=Path, help="Output JSON path")

    serve_parser = subparsers.add_parser("serve", help="Run the modeler API service")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8001)

    args = parser.parse_args(argv)

    if args.command == "export":
        events = _load_events(args.paths)
        export_flow(events, args.out)
        return 0
    if args.command == "serve":
        serve(args.host, args.port)
        return 0
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
