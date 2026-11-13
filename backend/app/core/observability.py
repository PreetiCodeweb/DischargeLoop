"""Operability without new dependencies: JSON logs, correlation IDs, RED metrics and Prometheus text exposition.

HIPAA: log lines carry route templates, status codes, timings and IDs only — never query strings, bodies,
patient names or SQL parameters.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections import defaultdict

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

_BUCKETS = (0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {"ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"), "level": record.levelname, "logger": record.name,
                 "msg": record.getMessage()}
        for key in ("correlation_id", "route", "method", "status", "duration_ms"):
            if hasattr(record, key):
                entry[key] = getattr(record, key)
        if record.exc_info:
            entry["exc_type"] = record.exc_info[0].__name__ if record.exc_info[0] else None  # type only: tracebacks may hold PHI
        return json.dumps(entry, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    logging.getLogger("uvicorn.access").disabled = True  # replaced by the PHI-free access log below


class _Metrics:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: dict[tuple[str, str, str], int] = defaultdict(int)
        self.buckets: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0] * (len(_BUCKETS) + 1))
        self.sums: dict[tuple[str, str], float] = defaultdict(float)

    def observe(self, route: str, method: str, status: int, seconds: float) -> None:
        with self.lock:
            self.requests[(route, method, str(status))] += 1
            counts = self.buckets[(route, method)]
            for i, bound in enumerate(_BUCKETS):
                if seconds <= bound:
                    counts[i] += 1
            counts[-1] += 1
            self.sums[(route, method)] += seconds

    def render(self) -> list[str]:
        lines = ["# HELP dl_http_requests_total HTTP requests by route template, method and status.",
                 "# TYPE dl_http_requests_total counter"]
        with self.lock:
            for (route, method, code), n in sorted(self.requests.items()):
                lines.append(f'dl_http_requests_total{{route="{route}",method="{method}",code="{code}"}} {n}')
            lines += ["# HELP dl_http_request_duration_seconds HTTP request latency.", "# TYPE dl_http_request_duration_seconds histogram"]
            for (route, method), counts in sorted(self.buckets.items()):
                labels = f'route="{route}",method="{method}"'
                for bound, n in zip(_BUCKETS, counts):
                    lines.append(f'dl_http_request_duration_seconds_bucket{{{labels},le="{bound}"}} {n}')
                lines.append(f'dl_http_request_duration_seconds_bucket{{{labels},le="+Inf"}} {counts[-1]}')
                lines.append(f"dl_http_request_duration_seconds_sum{{{labels}}} {self.sums[(route, method)]:.6f}")
                lines.append(f"dl_http_request_duration_seconds_count{{{labels}}} {counts[-1]}")
        return lines


METRICS = _Metrics()
access_log = logging.getLogger("dischargeloop.access")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Correlation ID in/out, RED metrics keyed by route *template* (bounded cardinality, no IDs in labels)."""

    async def dispatch(self, request: Request, call_next):
        cid = request.headers.get("x-correlation-id") or str(uuid.uuid4())
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Correlation-Id"] = cid
            return response
        finally:
            elapsed = time.perf_counter() - start
            route_obj = request.scope.get("route")
            route = getattr(route_obj, "path", None) or "unmatched"
            METRICS.observe(route, request.method, status, elapsed)
            if route not in ("/health", "/ready", "/metrics"):
                access_log.info("request", extra={"correlation_id": cid, "route": route, "method": request.method,
                                                   "status": status, "duration_ms": round(elapsed * 1000, 1)})
