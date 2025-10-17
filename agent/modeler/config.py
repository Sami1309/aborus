"""Runtime configuration helpers for the modeler service."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class ServerResourceLimits:
    """Holds runtime knobs that help constrain server resource usage."""

    profile: str = "standard"
    uvicorn_overrides: Dict[str, Any] = field(default_factory=dict)
    threadpool_workers: Optional[int] = None

    def merge_uvicorn_kwargs(self, base: Dict[str, Any]) -> Dict[str, Any]:
        """Merge the overrides into a copy of *base* and return the result."""

        merged = dict(base)
        for key, value in self.uvicorn_overrides.items():
            merged[key] = value
        return merged


_CONSTRAINED_ALIASES = {"constrained", "low", "low_power", "low-power", "light", "lightweight"}
_STANDARD_ALIASES = {"standard", "default", "off", "disabled", "none"}


def _parse_int(value: str) -> Optional[int]:
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def load_server_resource_limits(env: Optional[Dict[str, str]] = None) -> ServerResourceLimits:
    """Read ``MODELER_SERVER_LIMITS`` from *env* and build a limits object.

    Supported formats:
    * ``MODELER_SERVER_LIMITS=constrained`` → built-in safe defaults.
    * ``MODELER_SERVER_LIMITS=standard`` → disable special handling.
    * ``MODELER_SERVER_LIMITS=key=value,key=value`` → explicit overrides.

    Recognised keys for explicit overrides:
    ``limit_concurrency`` (int), ``workers`` (int), ``timeout_keep_alive`` (int),
    ``limit_max_requests`` (int), ``backlog`` (int), ``loop`` (str), ``http`` (str),
    ``threadpool_workers`` (int).
    """

    source = env if env is not None else os.environ
    raw = (source.get("MODELER_SERVER_LIMITS") or "").strip()
    if not raw:
        return ServerResourceLimits()

    lowered = raw.lower()
    if lowered in _STANDARD_ALIASES:
        return ServerResourceLimits()
    if lowered in _CONSTRAINED_ALIASES:
        return ServerResourceLimits(
            profile="constrained",
            uvicorn_overrides={
                "workers": 1,
                "loop": "asyncio",
                "http": "h11",
                "limit_concurrency": 4,
                "timeout_keep_alive": 5,
                "backlog": 32,
            },
            threadpool_workers=4,
        )

    overrides: Dict[str, Any] = {}
    threadpool_workers: Optional[int] = None
    for part in raw.split(","):
        if not part:
            continue
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip().lower()
        value = value.strip()
        if not key:
            continue
        if key in {"limit_concurrency", "workers", "timeout_keep_alive", "limit_max_requests", "backlog"}:
            parsed = _parse_int(value)
            if parsed is not None:
                overrides[key] = parsed
            continue
        if key in {"loop", "http"}:
            if value:
                overrides[key] = value
            continue
        if key == "threadpool_workers":
            parsed = _parse_int(value)
            if parsed is not None:
                threadpool_workers = parsed if parsed > 0 else None
            continue
    profile = "custom" if overrides or threadpool_workers else "standard"
    return ServerResourceLimits(profile=profile, uvicorn_overrides=overrides, threadpool_workers=threadpool_workers)
