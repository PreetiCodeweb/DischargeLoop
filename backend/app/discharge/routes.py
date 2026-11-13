"""HTTP API for DischargeLoop (`/api/v1/dl/*`) and the EHR interface endpoint (`/api/v1/integrations/hl7`)."""
from __future__ import annotations

import hmac
import os
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.database.session import get_db
from app.discharge import escalation, hl7, service as svc
from app.discharge.domain import BLOCKER_CATEGORIES, HOSPITAL_WIDE_ROLES, Actor, DomainError
from app.models.models import User

router = APIRouter(prefix="/dl", tags=["DischargeLoop"])
integration_router = APIRouter(prefix="/integrations", tags=["EHR integration"])


def current_actor(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> Actor:
    role = str(user.role)
    if role in HOSPITAL_WIDE_ROLES:
        wards = None
    else:
        rows = db.execute(text("SELECT ward_id FROM dischargeloop.user_ward_scope WHERE user_id = :u"), {"u": str(user.id)}).fetchall()
        wards = frozenset(str(r[0]) for r in rows)
    return Actor(user_id=str(user.id), role=role, email=user.email, full_name=user.full_name, ward_ids=wards)


def _cid(request: Request) -> str:
    return request.headers.get("x-correlation-id") or str(uuid.uuid4())


def _ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def domain_error_handler(_: Request, exc: DomainError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"code": exc.code, "detail": exc.message})


class InitiateIn(BaseModel):
    encounter_id: str
    expected_discharge_at: datetime | None = None


class TransitionIn(BaseModel):
    target_state: str = Field(pattern="^(INITIATED|MEDICALLY_CLEARED|TASKS_PENDING|READY_TO_DEPART|DEPARTED|CANCELLED|CANCELLED_REVERSED)$")
    reason: str | None = Field(default=None, max_length=500)
    expected_version: int | None = None


class EddIn(BaseModel):
    expected_discharge_at: datetime | None


class TaskIn(BaseModel):
    type: str = Field(min_length=2, max_length=48, pattern="^[A-Z0-9_]+$")
    title: str = Field(min_length=3, max_length=160)
    owner_role: str = Field(min_length=2, max_length=48)
    due_in_minutes: int = Field(default=120, ge=5, le=7 * 24 * 60)
    priority: int = Field(default=3, ge=1, le=5)
    blocking: bool = True


class BlockerIn(BaseModel):
    category: str
    description: str = Field(min_length=3, max_length=280)
    side: str | None = Field(default=None, pattern="^(INTERNAL|EXTERNAL)$")
    external_party: str | None = Field(default=None, max_length=160)
    owner_role: str | None = Field(default=None, max_length=48)
    due_in_minutes: int = Field(default=240, ge=5, le=7 * 24 * 60)


class CloseIn(BaseModel):
    note: str | None = Field(default=None, max_length=280)


class AdmitIn(BaseModel):
    mrn: str = Field(min_length=1, max_length=128)
    patient_name: str = Field(min_length=2, max_length=180)
    date_of_birth: datetime | None = None
    ward_id: str
    bed_id: str | None = None
    visit_number: str | None = Field(default=None, max_length=128)


class ReserveIn(BaseModel):
    ttl_minutes: int = Field(default=60, ge=5, le=24 * 60)


@router.get("/meta")
def meta(_: Actor = Depends(current_actor)):
    return {"blocker_categories": BLOCKER_CATEGORIES}


@router.get("/wards")
def wards(actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.list_wards(db, actor)


@router.get("/worklist")
def worklist(request: Request, ward_id: str | None = None, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.worklist(db, actor, ward_id, _cid(request), _ip(request))


@router.post("/discharges", status_code=201)
def initiate(payload: InitiateIn, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.initiate_discharge(db, actor, payload.encounter_id, _cid(request), payload.expected_discharge_at)


@router.get("/discharges/{discharge_id}")
def discharge_detail(discharge_id: str, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.get_discharge(db, actor, discharge_id, _cid(request), _ip(request))


@router.post("/discharges/{discharge_id}/transition")
def transition(discharge_id: str, payload: TransitionIn, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.transition_discharge(db, actor, discharge_id, payload.target_state, _cid(request), payload.reason, payload.expected_version)


@router.patch("/discharges/{discharge_id}/expected-discharge")
def set_edd(discharge_id: str, payload: EddIn, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.update_expected_discharge(db, actor, discharge_id, payload.expected_discharge_at, _cid(request))


@router.post("/discharges/{discharge_id}/tasks", status_code=201)
def add_task(discharge_id: str, payload: TaskIn, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    due = datetime.now(timezone.utc) + timedelta(minutes=payload.due_in_minutes)
    return svc.create_task(db, actor, discharge_id, payload.type, payload.title, payload.owner_role, due, payload.priority, payload.blocking, _cid(request))


@router.post("/discharges/{discharge_id}/blockers", status_code=201)
def add_blocker(discharge_id: str, payload: BlockerIn, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.open_blocker(db, actor, discharge_id, payload.category, payload.description, _cid(request), payload.side,
                            payload.external_party, payload.owner_role, payload.due_in_minutes)


@router.post("/blockers/{blocker_id}/{action}")
def close_blocker(blocker_id: str, action: str, payload: CloseIn, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    if action not in ("resolve", "cancel"):
        raise HTTPException(404, "Unknown action")
    return svc.close_blocker(db, actor, blocker_id, action, payload.note, _cid(request))


@router.get("/tasks")
def tasks(mine: bool = True, ward_id: str | None = None, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.list_tasks(db, actor, mine, ward_id)


@router.post("/tasks/{task_id}/{action}")
def task_action(task_id: str, action: str, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    if action not in ("claim", "complete", "cancel"):
        raise HTTPException(404, "Unknown action")
    return svc.act_on_task(db, actor, task_id, action, _cid(request))


@router.get("/beds")
def beds(ward_id: str | None = None, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.list_beds(db, actor, ward_id)


@router.post("/beds/{bed_id}/reserve", status_code=201)
def reserve(bed_id: str, payload: ReserveIn, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.reserve_bed(db, actor, bed_id, payload.ttl_minutes, _cid(request))


@router.post("/beds/{bed_id}/release")
def release(bed_id: str, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    actor.require(svc.CAN_RESERVE, "release reservations")
    svc.release_reservation(db, actor, bed_id, _cid(request))
    db.commit()
    return {"bed_id": bed_id, "state": "AVAILABLE"}


@router.post("/admissions", status_code=201)
def admit(payload: AdmitIn, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    """Manual admission for sites without an ADT feed yet (HL7 A01 is the normal path)."""
    hospital = db.execute(text("SELECT id FROM dischargeloop.hospital ORDER BY is_primary DESC LIMIT 1")).scalar()
    patient_id = svc.upsert_patient(db, str(hospital), payload.mrn, payload.patient_name,
                                    payload.date_of_birth.date() if payload.date_of_birth else None)
    encounter_id = svc.admit(db, actor, patient_id, payload.ward_id, payload.bed_id, payload.visit_number or f"MANUAL-{uuid.uuid4().hex[:12]}", _cid(request))
    return {"encounter_id": encounter_id}


@router.get("/cleaning")
def cleaning(actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.list_cleaning(db, actor)


@router.post("/cleaning/{cleaning_id}/{action}")
def cleaning_action(cleaning_id: str, action: str, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.act_on_cleaning(db, actor, cleaning_id, action, _cid(request))


@router.get("/notifications")
def notifications(unread: bool = False, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.list_notifications(db, actor, unread)


@router.post("/notifications/{notification_id}/read", status_code=204)
def notification_read(notification_id: str, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    svc.mark_notification_read(db, actor, notification_id)


class WardScopeIn(BaseModel):
    ward_ids: list[str] = Field(max_length=200)


@router.get("/users/{user_id}/wards")
def user_wards(user_id: str, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.get_user_wards(db, actor, user_id)


@router.put("/users/{user_id}/wards")
def assign_user_wards(user_id: str, payload: WardScopeIn, request: Request, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.set_user_wards(db, actor, user_id, payload.ward_ids, _cid(request))


@router.get("/metrics")
def metrics(actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.metrics(db, actor)


@router.get("/audit")
def audit(limit: int = 100, actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    return svc.audit_trail(db, actor, limit)


@router.post("/escalations/run")
def run_escalations(actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    actor.require(frozenset({"system_admin", "hospital_admin", "operations_manager"}), "run escalations")
    return {"escalated": escalation.run_escalations(db)}


@router.get("/feed-health")
def feed_health(_: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    """Visible to all staff (no PHI) so the worklist can warn that EHR updates may be missing."""
    return hl7.feed_health(db)


@router.get("/integration/status")
def integration_status(actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    actor.require(frozenset({"system_admin", "hospital_admin", "operations_manager"}), "view integration status")
    return hl7.integration_status(db)


@integration_router.post("/hl7", response_class=PlainTextResponse)
async def ingest_hl7(request: Request, authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    """Interface-engine endpoint. Auth: `Authorization: Bearer <HL7_INGEST_TOKEN>` (shared secret, constant-time compare)."""
    expected = os.environ.get("HL7_INGEST_TOKEN", "")
    supplied = (authorization or "").removeprefix("Bearer ").strip()
    if not expected or not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(401, "Invalid integration credentials")
    body = (await request.body()).decode("utf-8", errors="replace")
    if len(body) > 1_000_000:
        raise HTTPException(413, "HL7 message too large")
    status, ack_text = hl7.ingest(db, body)
    return PlainTextResponse(ack_text, status_code=status, media_type="application/hl7-v2")
