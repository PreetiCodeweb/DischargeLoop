import hmac
import os
from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.middleware import ErrorHandlingMiddleware
from app.core.observability import METRICS, RequestContextMiddleware, configure_logging
from app.database.session import SessionLocal, get_db
from app.models import models  # register models
from app.api.routes import auth, dashboard, forecast, simulation, operations, admin
from app.discharge.domain import DomainError
from app.discharge.routes import domain_error_handler, integration_router, router as discharge_router
from app.services.seed import seed_demo

settings = get_settings()
configure_logging(os.environ.get("LOG_LEVEL", "INFO"))

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Schema is owned by migrations (app.db_migrate, migrator role); the API role has no DDL rights.
    if settings.AUTO_SEED and settings.ENVIRONMENT != "testing":
        db = SessionLocal()
        try:
            seed_demo(db)
        finally:
            db.close()
    yield

app = FastAPI(
    title="DischargeLoop",
    version=settings.APP_VERSION,
    description="Discharge & handoff coordination with the MedSync Command Center.",
    lifespan=lifespan,
)

app.add_exception_handler(DomainError, domain_error_handler)
app.add_middleware(ErrorHandlingMiddleware)
app.add_middleware(RequestContextMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Correlation-Id", "Idempotency-Key"],
)

app.include_router(auth.router, prefix="/api/v1")
app.include_router(dashboard.router, prefix="/api/v1")
app.include_router(forecast.router, prefix="/api/v1")
app.include_router(simulation.router, prefix="/api/v1")
app.include_router(operations.router, prefix="/api/v1")
app.include_router(admin.router, prefix="/api/v1")
app.include_router(discharge_router, prefix="/api/v1")
app.include_router(integration_router, prefix="/api/v1")

@app.get("/", tags=["System"])
def root():
    return {"name": "DischargeLoop", "version": settings.APP_VERSION, "status": "operational", "docs": "/docs"}

@app.get("/health", tags=["System"])
def health():
    """Liveness: the process is up. Never touches dependencies (a DB blip must not restart every pod)."""
    return {"status": "healthy", "service": "dischargeloop", "version": settings.APP_VERSION}


@app.get("/ready", tags=["System"])
def ready(db: Session = Depends(get_db)):
    """Readiness: database reachable and the schema migrated. Load balancers route traffic only when 200."""
    try:
        applied = db.execute(text("SELECT count(*) FROM dischargeloop.schema_migrations")).scalar_one()
    except SQLAlchemyError as exc:
        return JSONResponse(status_code=503, content={"status": "not_ready", "reason": type(exc).__name__})
    if not applied:
        return JSONResponse(status_code=503, content={"status": "not_ready", "reason": "schema not migrated"})
    return {"status": "ready", "migrations": applied}


_GAUGES_SQL = """
SELECT
  (SELECT extract(epoch FROM now() - max(created_at)) FROM dischargeloop.hl7_event_log) AS hl7_last_message_age_seconds,
  (SELECT count(*) FROM dischargeloop.hl7_event_log WHERE created_at > now() - interval '5 minutes') AS hl7_messages_last_5m,
  (SELECT count(*) FROM dischargeloop.integration_quarantine WHERE resolved_at IS NULL) AS hl7_quarantine_open,
  (SELECT count(*) FROM dischargeloop.task WHERE status IN ('OPEN', 'CLAIMED') AND due_at < now()) AS tasks_overdue,
  (SELECT count(*) FROM dischargeloop.discharge WHERE state IN ('INITIATED', 'MEDICALLY_CLEARED', 'TASKS_PENDING', 'READY_TO_DEPART')) AS discharges_in_progress,
  (SELECT count(*) FROM dischargeloop.discharge WHERE state = 'READY_TO_DEPART') AS discharges_ready_to_depart,
  (SELECT count(*) FROM dischargeloop.blocker WHERE status = 'OPEN' AND side = 'EXTERNAL') AS blockers_external_open,
  (SELECT count(*) FROM dischargeloop.bed WHERE state = 'CLEANING') AS beds_cleaning,
  (SELECT count(*) FROM dischargeloop.outbox WHERE published_at IS NULL) AS outbox_unpublished
"""


@app.get("/metrics", tags=["System"], response_class=PlainTextResponse)
def metrics(db: Session = Depends(get_db), authorization: str | None = Header(default=None)):
    """Prometheus text format. Aggregates only (no PHI). Optional bearer token via METRICS_TOKEN."""
    expected = os.environ.get("METRICS_TOKEN", "")
    if expected and not hmac.compare_digest((authorization or "").removeprefix("Bearer ").encode(), expected.encode()):
        raise HTTPException(401, "Invalid metrics token")
    lines = METRICS.render()
    try:
        row = db.execute(text(_GAUGES_SQL)).mappings().one()
        lines.append("dl_up 1")
        for name, value in row.items():
            lines += [f"# TYPE dl_{name} gauge", f"dl_{name} {float(value) if value is not None else 'NaN'}"]
    except SQLAlchemyError:
        lines.append("dl_up 0")
    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4")
