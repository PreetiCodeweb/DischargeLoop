"""DischargeLoop application services: every state change is one transaction with audit + outbox.

All SQL is schema-qualified (``dischargeloop.``) and parameterised. Rows that are changed are
locked with ``FOR UPDATE`` so concurrent requests serialise instead of racing.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.discharge.domain import (
    ACTIVE_DISCHARGE_STATES, CAN_CLEAN, CAN_INITIATE, CAN_MANAGE_ANY_TASK, CAN_MANAGE_BLOCKERS, CAN_RESERVE,
    CAN_TRANSITION, DEFAULT_BLOCKER_OWNER, DEFAULT_BLOCKER_SIDE, DEFAULT_TASK_TEMPLATES, DISCHARGE_REASON,
    TASK_OWNER_ROLES, Actor, DomainError, assert_bed_transition, assert_discharge_transition, functional_role,
)

SYSTEM_ACTOR_ID = "00000000-0000-7000-8000-000000000001"
SCHEMA = "dischargeloop"
DB_NOW = object()  # sentinel: render as SQL now() instead of binding the app server's clock


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id() -> str:
    return str(uuid.uuid4())


def _rows(db: Session, sql: str, **params: Any) -> list[dict[str, Any]]:
    return [dict(r) for r in db.execute(text(sql), params).mappings().all()]


def _row(db: Session, sql: str, **params: Any) -> dict[str, Any] | None:
    r = db.execute(text(sql), params).mappings().first()
    return dict(r) if r else None


def _scope_params(actor: Actor) -> dict[str, Any]:
    return {"all_wards": actor.hospital_wide, "scope": sorted(actor.ward_ids or [])}


SCOPE_SQL = "(:all_wards OR {col} = ANY(CAST(:scope AS uuid[])))"


# ---------------------------------------------------------------- cross-cutting records
def audit(db: Session, actor_id: str, actor_role: str, action: str, entity_type: str, entity_id: str,
          before: dict | None, after: dict, reason: str, correlation_id: str) -> None:
    db.execute(text(
        f"INSERT INTO {SCHEMA}.audit_event (id, actor_id, actor_role, action, entity_type, entity_id, before_state,"
        " after_state, reason_code, correlation_id) VALUES (:id, :actor_id, :actor_role, :action, :entity_type,"
        " :entity_id, CAST(:before AS jsonb), CAST(:after AS jsonb), CAST(:reason AS dischargeloop.reason_code), :cid)"),
        {"id": _id(), "actor_id": actor_id, "actor_role": actor_role, "action": action, "entity_type": entity_type,
         "entity_id": str(entity_id), "before": json.dumps(before, default=str) if before is not None else None,
         "after": json.dumps(after, default=str), "reason": reason, "cid": correlation_id})


def outbox(db: Session, aggregate_type: str, aggregate_id: str, event_type: str, payload: dict, correlation_id: str) -> None:
    db.execute(text(
        f"INSERT INTO {SCHEMA}.outbox (id, aggregate_type, aggregate_id, event_type, payload, headers)"
        " VALUES (:id, :at, :aid, :et, CAST(:payload AS jsonb), CAST(:headers AS jsonb))"),
        {"id": _id(), "at": aggregate_type, "aid": str(aggregate_id), "et": event_type,
         "payload": json.dumps(payload, default=str), "headers": json.dumps({"correlationId": correlation_id})})


def notify(db: Session, role: str, ward_id: str | None, kind: str, severity: str, title: str, body: str,
           entity_type: str | None, entity_id: str | None, dedupe_key: str) -> None:
    """In-app notification. Bodies carry bed/task context only — no patient names (minimum necessary)."""
    db.execute(text(
        f"INSERT INTO {SCHEMA}.notification (id, recipient_role, recipient_ward_id, kind, severity, title, body,"
        " entity_type, entity_id, dedupe_key) VALUES (:id, :role, :ward, :kind, :sev, :title, :body, :et, :eid, :dk)"
        " ON CONFLICT (dedupe_key) DO NOTHING"),
        {"id": _id(), "role": role, "ward": ward_id, "kind": kind, "sev": severity, "title": title[:160],
         "body": body[:500], "et": entity_type, "eid": entity_id, "dk": dedupe_key[:200]})


def log_phi_access(db: Session, actor: Actor, action: str, correlation_id: str, client_ip: str | None,
                   ward_id: str | None = None, encounter_id: str | None = None, patient_count: int = 1) -> None:
    """HIPAA: record who viewed which patient data (read access, not just changes)."""
    db.execute(text(
        f"INSERT INTO {SCHEMA}.phi_access_log (id, actor_id, actor_role, action, ward_id, encounter_id,"
        " patient_count, correlation_id, client_ip) VALUES (:id, :aid, :role, :action, :ward, :enc, :n, :cid, :ip)"),
        {"id": _id(), "aid": actor.user_id, "role": actor.role, "action": action, "ward": ward_id,
         "enc": encounter_id, "n": patient_count, "cid": correlation_id, "ip": client_ip})


# ---------------------------------------------------------------- read models
def list_wards(db: Session, actor: Actor) -> list[dict[str, Any]]:
    return _rows(db, f"SELECT * FROM {SCHEMA}.ward_capacity_v WHERE {SCOPE_SQL.format(col='ward_id')} ORDER BY code",
                 **_scope_params(actor))


WORKLIST_SQL = f"""
SELECT e.id AS encounter_id, e.his_encounter_id, e.admitted_at, w.id AS ward_id, w.code AS ward_code,
       p.display_name AS patient_name, p.his_patient_id AS mrn, p.date_of_birth, b.id AS bed_id, b.label AS bed_label,
       d.id AS discharge_id, coalesce(d.state::text, 'NOT_STARTED') AS state, d.version, d.expected_discharge_at,
       d.initiated_at, d.cleared_at, d.ready_at, d.reversal_count, d.reversal_reason, d.source,
       -- The core delay measure: how long a medically ready patient has been waiting (DB clock).
       CASE WHEN d.state IN ('MEDICALLY_CLEARED', 'TASKS_PENDING', 'READY_TO_DEPART') AND d.cleared_at IS NOT NULL
            THEN round((extract(epoch FROM now() - d.cleared_at) / 3600)::numeric, 1)::float END AS hours_since_medically_cleared,
       (SELECT json_build_object('id', bl.id, 'category', bl.category, 'side', bl.side, 'description', bl.description,
               'external_party', bl.external_party, 'opened_at', bl.opened_at)
          FROM {SCHEMA}.blocker bl WHERE bl.discharge_id = d.id AND bl.status = 'OPEN' ORDER BY bl.opened_at LIMIT 1) AS top_blocker,
       (SELECT count(*) FROM {SCHEMA}.blocker bl WHERE bl.discharge_id = d.id AND bl.status = 'OPEN') AS open_blockers,
       (SELECT count(*) FROM {SCHEMA}.blocker bl WHERE bl.discharge_id = d.id AND bl.status = 'OPEN' AND bl.side = 'EXTERNAL') AS external_blockers,
       (SELECT json_build_object('id', t.id, 'title', t.title, 'owner', t.owner_role || coalesce('@' || ow.code, ''), 'due_at', t.due_at)
          FROM {SCHEMA}.task t LEFT JOIN {SCHEMA}.ward ow ON ow.id = t.owner_ward_id
         WHERE t.encounter_id = e.id AND t.status IN ('OPEN', 'CLAIMED') ORDER BY t.due_at LIMIT 1) AS next_task,
       (SELECT count(*) FROM {SCHEMA}.task t WHERE t.encounter_id = e.id AND t.status IN ('OPEN', 'CLAIMED')) AS open_tasks,
       (SELECT count(*) FROM {SCHEMA}.task t WHERE t.encounter_id = e.id AND t.status IN ('OPEN', 'CLAIMED') AND t.due_at < now()) AS overdue_tasks,
       e.patient_class, e.on_leave, e.medicare
  FROM {SCHEMA}.encounter e
  JOIN {SCHEMA}.patient p ON p.id = e.patient_id
  JOIN {SCHEMA}.ward w ON w.id = e.ward_id
  LEFT JOIN {SCHEMA}.bed b ON b.id = e.bed_id
  LEFT JOIN {SCHEMA}.discharge d ON d.encounter_id = e.id
 WHERE e.status = 'ADMITTED'
   AND (CAST(:ward_id AS uuid) IS NULL OR e.ward_id = CAST(:ward_id AS uuid))
   AND {SCOPE_SQL.format(col='e.ward_id')}
 ORDER BY CASE coalesce(d.state::text, 'NOT_STARTED') WHEN 'READY_TO_DEPART' THEN 0 WHEN 'TASKS_PENDING' THEN 1
          WHEN 'MEDICALLY_CLEARED' THEN 2 WHEN 'INITIATED' THEN 3 WHEN 'CANCELLED_REVERSED' THEN 4 ELSE 5 END,
          d.expected_discharge_at NULLS LAST, b.label
"""


def worklist(db: Session, actor: Actor, ward_id: str | None, correlation_id: str, client_ip: str | None) -> dict[str, Any]:
    """Feature 1: what is blocking each patient's discharge, who owns the next step, and how late it is."""
    if ward_id and not actor.can_see_ward(ward_id):
        raise DomainError("FORBIDDEN", "Ward is outside your access scope", 403)
    items = _rows(db, WORKLIST_SQL, ward_id=ward_id, **_scope_params(actor))
    log_phi_access(db, actor, "VIEW_WORKLIST", correlation_id, client_ip, ward_id=ward_id, patient_count=len(items))
    db.commit()
    summary = {
        "patients": len(items),
        "in_progress": sum(1 for i in items if i["state"] in ACTIVE_DISCHARGE_STATES),
        "ready_to_depart": sum(1 for i in items if i["state"] == "READY_TO_DEPART"),
        "overdue_tasks": sum(int(i["overdue_tasks"] or 0) for i in items),
        "external_blockers": sum(int(i["external_blockers"] or 0) for i in items),
    }
    return {"summary": summary, "items": items}


def _discharge_for_update(db: Session, discharge_id: str) -> dict[str, Any]:
    row = _row(db, f"""
        SELECT d.*, d.state::text AS state, e.ward_id, e.bed_id, e.status::text AS encounter_status, w.code AS ward_code
          FROM {SCHEMA}.discharge d JOIN {SCHEMA}.encounter e ON e.id = d.encounter_id
          JOIN {SCHEMA}.ward w ON w.id = e.ward_id
         WHERE d.id = CAST(:id AS uuid) FOR UPDATE OF d""", id=discharge_id)
    if not row:
        raise DomainError("NOT_FOUND", "Discharge not found", 404)
    return row


def get_discharge(db: Session, actor: Actor, discharge_id: str, correlation_id: str, client_ip: str | None) -> dict[str, Any]:
    d = _row(db, f"""
        SELECT d.id, d.state::text AS state, d.version, d.expected_discharge_at, d.initiated_at, d.cleared_at, d.ready_at,
               d.departed_at, d.reversal_reason, d.reversal_count, d.reversed_at, d.source, e.id AS encounter_id,
               e.ward_id, w.code AS ward_code, b.label AS bed_label, p.display_name AS patient_name, p.his_patient_id AS mrn
          FROM {SCHEMA}.discharge d JOIN {SCHEMA}.encounter e ON e.id = d.encounter_id
          JOIN {SCHEMA}.patient p ON p.id = e.patient_id JOIN {SCHEMA}.ward w ON w.id = e.ward_id
          LEFT JOIN {SCHEMA}.bed b ON b.id = e.bed_id WHERE d.id = CAST(:id AS uuid)""", id=discharge_id)
    if not d or not actor.can_see_ward(str(d["ward_id"])):
        raise DomainError("NOT_FOUND", "Discharge not found", 404)
    d["tasks"] = _rows(db, f"""
        SELECT t.id, t.type, t.title, t.owner_role, ow.code AS owner_ward_code, t.owner_role || coalesce('@' || ow.code, '') AS owner,
               t.owner_user_id, t.status::text AS status, t.priority, t.blocking, t.due_at, t.completed_at,
               t.escalation_level, t.source, t.blocker_id, t.version, (t.status IN ('OPEN', 'CLAIMED') AND t.due_at < now()) AS overdue
          FROM {SCHEMA}.task t LEFT JOIN {SCHEMA}.ward ow ON ow.id = t.owner_ward_id
         WHERE t.encounter_id = CAST(:enc AS uuid) ORDER BY t.status, t.due_at""", enc=str(d["encounter_id"]))
    d["blockers"] = _rows(db, f"""
        SELECT id, category::text AS category, side::text AS side, status::text AS status, description, external_party,
               owner_role, opened_at, resolved_at, resolution_note, version
          FROM {SCHEMA}.blocker WHERE discharge_id = CAST(:id AS uuid) ORDER BY status, opened_at""", id=discharge_id)
    d["timeline"] = _rows(db, f"""
        SELECT occurred_at, actor_role, action, reason_code::text AS reason_code, after_state
          FROM {SCHEMA}.audit_event WHERE entity_id = CAST(:id AS uuid)
             OR entity_id IN (SELECT id FROM {SCHEMA}.task WHERE encounter_id = CAST(:enc AS uuid))
             OR entity_id IN (SELECT id FROM {SCHEMA}.blocker WHERE discharge_id = CAST(:id AS uuid))
         ORDER BY occurred_at DESC LIMIT 100""", id=discharge_id, enc=str(d["encounter_id"]))
    log_phi_access(db, actor, "VIEW_DISCHARGE", correlation_id, client_ip, ward_id=str(d["ward_id"]),
                   encounter_id=str(d["encounter_id"]))
    db.commit()
    return d


# ---------------------------------------------------------------- discharge lifecycle
def initiate_discharge(db: Session, actor: Actor, encounter_id: str, correlation_id: str,
                       expected_discharge_at: datetime | None = None, source: str = "MANUAL") -> dict[str, Any]:
    actor.require(CAN_INITIATE, "initiate a discharge")
    enc = _row(db, f"SELECT id, ward_id, status::text AS status FROM {SCHEMA}.encounter WHERE id = CAST(:id AS uuid) FOR UPDATE",
               id=encounter_id)
    if not enc or not actor.can_see_ward(str(enc["ward_id"])):
        raise DomainError("NOT_FOUND", "Encounter not found", 404)
    if enc["status"] != "ADMITTED":
        raise DomainError("ENCOUNTER_NOT_ADMITTED", "Only admitted patients can start a discharge")
    existing = _row(db, f"SELECT id, state::text AS state FROM {SCHEMA}.discharge WHERE encounter_id = CAST(:id AS uuid)",
                    id=encounter_id)
    if existing:
        if existing["state"] in ACTIVE_DISCHARGE_STATES:
            return {"id": str(existing["id"]), "state": existing["state"], "created": False}
        if existing["state"] in ("CANCELLED", "CANCELLED_REVERSED"):
            result = transition_discharge(db, actor, str(existing["id"]), "INITIATED", correlation_id, commit=False)
            if expected_discharge_at:
                db.execute(text(f"UPDATE {SCHEMA}.discharge SET expected_discharge_at = :edd WHERE id = CAST(:id AS uuid)"),
                           {"edd": expected_discharge_at, "id": str(existing["id"])})
            db.commit()
            return {**result, "created": False, "restarted": True}
        raise DomainError("DISCHARGE_COMPLETED", "This encounter has already departed")
    discharge_id = _id()
    db.execute(text(
        f"INSERT INTO {SCHEMA}.discharge (id, encounter_id, state, initiated_by, expected_discharge_at, source)"
        " VALUES (:id, :enc, 'INITIATED', :by, :edd, :src)"),
        {"id": discharge_id, "enc": encounter_id, "by": actor.user_id, "edd": expected_discharge_at, "src": source})
    after = {"state": "INITIATED", "expected_discharge_at": expected_discharge_at, "source": source}
    audit(db, actor.user_id, actor.role, "discharge.initiated", "discharge", discharge_id, None, after, "DISCHARGE_INITIATED", correlation_id)
    outbox(db, "discharge", discharge_id, "DischargeInitiated", {"encounterId": encounter_id, **after}, correlation_id)
    db.commit()
    return {"id": discharge_id, "state": "INITIATED", "created": True}


def transition_discharge(db: Session, actor: Actor, discharge_id: str, target: str, correlation_id: str,
                         reason: str | None = None, expected_version: int | None = None, commit: bool = True) -> dict[str, Any]:
    d = _discharge_for_update(db, discharge_id)
    if not actor.can_see_ward(str(d["ward_id"])):
        raise DomainError("NOT_FOUND", "Discharge not found", 404)
    if target not in CAN_TRANSITION:
        raise DomainError("ILLEGAL_DISCHARGE_TRANSITION", f"Unknown target state {target}", 400)
    actor.require(CAN_TRANSITION[target], f"move a discharge to {target}")
    if expected_version is not None and expected_version != d["version"]:
        raise DomainError("VERSION_CONFLICT", "This discharge was changed by someone else; refresh and retry")
    assert_discharge_transition(d["state"], target)
    reason = (reason or "").strip() or None
    if target in ("CANCELLED", "CANCELLED_REVERSED") and not reason:
        raise DomainError("REASON_REQUIRED", "A reason is required to cancel or reverse a discharge", 400)
    if reason and len(reason) > 500:
        raise DomainError("REASON_TOO_LONG", "Reason must be 500 characters or fewer", 400)

    # Lifecycle timestamps use the database clock (DB_NOW -> SQL now()) so they order correctly against
    # task/blocker timestamps written by SQL; app and DB hosts' clocks can drift apart.
    now = DB_NOW
    sets: dict[str, Any] = {"state": target}
    ward_id, bed_id, ward_code = str(d["ward_id"]), d["bed_id"], d["ward_code"]

    if target == "READY_TO_DEPART":
        open_items = _row(db, f"""
            SELECT (SELECT count(*) FROM {SCHEMA}.task WHERE encounter_id = CAST(:enc AS uuid) AND blocking AND status IN ('OPEN', 'CLAIMED')) AS tasks,
                   (SELECT count(*) FROM {SCHEMA}.blocker WHERE discharge_id = CAST(:id AS uuid) AND status = 'OPEN') AS blockers""",
                          id=discharge_id, enc=str(d["encounter_id"]))
        if open_items["tasks"] or open_items["blockers"]:
            raise DomainError("DISCHARGE_BLOCKED",
                              f"{open_items['tasks']} blocking task(s) and {open_items['blockers']} blocker(s) are still open")
        sets["ready_at"] = now
    elif target == "MEDICALLY_CLEARED":
        sets["cleared_at"] = now
    elif target == "CANCELLED":
        sets["cancelled_reason_code"] = "DISCHARGE_CANCELLED"
        _cancel_open_work(db, actor, discharge_id, correlation_id, "TASK_CANCELLED")
    elif target == "INITIATED":  # restart after cancel/reversal
        sets.update(cleared_at=None, ready_at=None, cancelled_reason_code=None, initiated_at=now, initiated_by=actor.user_id)
    elif target == "CANCELLED_REVERSED":
        sets.update(reversal_reason=reason, reversed_at=now, reversal_count=d["reversal_count"] + 1,
                    cancelled_reason_code="DISCHARGE_CANCELLED_REVERSED", ready_at=None)
        _cancel_open_work(db, actor, discharge_id, correlation_id, "TASK_CANCELLED")
        if bed_id:
            # The bed stays OCCUPIED; any hold for an incoming patient on this bed is released.
            cancelled = db.execute(text(
                f"UPDATE {SCHEMA}.bed_assignment SET state = 'CANCELLED', ended_at = now(), updated_at = now()"
                " WHERE bed_id = :bed AND kind = 'RESERVATION' AND state = 'ACTIVE' RETURNING id"), {"bed": bed_id}).fetchall()
            sets["_cancelled_reservations"] = len(cancelled)
        label = f"Bed {_bed_label(db, bed_id)} ({ward_code})" if bed_id else f"Ward {ward_code}"
        for role in ("bed_manager", "admission", "nurse", "case_manager"):
            notify(db, role, None if role in ("bed_manager", "admission") else ward_id, "DISCHARGE_REVERSED", "CRITICAL",
                   f"Discharge reversed — {label} stays occupied",
                   f"Clinical reversal at READY/TASKS stage. Re-plan incoming placement. Reason: {reason}",
                   "discharge", discharge_id, f"reversal:{discharge_id}:{d['reversal_count'] + 1}:{role}")
    elif target == "DEPARTED":
        sets["departed_at"] = now
        db.execute(text(f"UPDATE {SCHEMA}.encounter SET status = 'DEPARTED', departed_at = now(), version = version + 1,"
                        " updated_at = now() WHERE id = :enc"), {"enc": d["encounter_id"]})
        if bed_id:
            _set_bed_state(db, actor, str(bed_id), "CLEANING", "PATIENT_DEPARTED", correlation_id)
            db.execute(text(f"UPDATE {SCHEMA}.bed_assignment SET state = 'ENDED', ended_at = now(), updated_at = now()"
                            " WHERE bed_id = :bed AND kind = 'OCCUPANCY' AND state = 'ACTIVE'"), {"bed": bed_id})
            db.execute(text(f"INSERT INTO {SCHEMA}.cleaning (id, bed_id) VALUES (:id, :bed)"), {"id": _id(), "bed": bed_id})
            notify(db, "housekeeping", ward_id, "CLEANING_REQUESTED", "INFO",
                   f"Clean bed {_bed_label(db, bed_id)} ({ward_code})", "Patient departed. Bed needs cleaning and verification.",
                   "bed", str(bed_id), f"cleaning:{bed_id}:{discharge_id}:{d['version']}")

    cancelled_reservations = sets.pop("_cancelled_reservations", 0)
    assignments = ", ".join(f"{k} = now()" if v is DB_NOW else f"{k} = :{k}" for k, v in sets.items())
    params = {k: v for k, v in sets.items() if v is not DB_NOW}
    db.execute(text(f"UPDATE {SCHEMA}.discharge SET {assignments}, version = version + 1, updated_at = now()"
                    " WHERE id = CAST(:discharge_id AS uuid)"), {**params, "discharge_id": discharge_id})

    if target == "TASKS_PENDING":
        _fan_out_default_tasks(db, actor, discharge_id, ward_id, ward_code, correlation_id)

    before = {"state": d["state"], "version": d["version"]}
    after = {"state": target, "version": d["version"] + 1, "reason": reason, "cancelledReservations": cancelled_reservations}
    audit(db, actor.user_id, actor.role, f"discharge.{target.lower()}", "discharge", discharge_id, before, after,
          DISCHARGE_REASON["INITIATED"] if target == "INITIATED" and d["state"] == "INITIATED" else
          ("DISCHARGE_RESTARTED" if target == "INITIATED" else DISCHARGE_REASON[target]), correlation_id)
    event = "DischargeReversed" if target == "CANCELLED_REVERSED" else "PatientDeparted" if target == "DEPARTED" else f"Discharge{target.title().replace('_', '')}"
    outbox(db, "discharge", discharge_id, event, {"encounterId": str(d["encounter_id"]), "bedId": str(bed_id) if bed_id else None,
                                                   "wardId": ward_id, **after}, correlation_id)
    if commit:
        db.commit()
    return {"id": discharge_id, "state": target, "version": d["version"] + 1}


def update_expected_discharge(db: Session, actor: Actor, discharge_id: str, expected: datetime | None, correlation_id: str) -> dict:
    actor.require(CAN_INITIATE, "change the expected discharge time")
    d = _discharge_for_update(db, discharge_id)
    if not actor.can_see_ward(str(d["ward_id"])):
        raise DomainError("NOT_FOUND", "Discharge not found", 404)
    db.execute(text(f"UPDATE {SCHEMA}.discharge SET expected_discharge_at = :edd, version = version + 1, updated_at = now()"
                    " WHERE id = CAST(:id AS uuid)"), {"edd": expected, "id": discharge_id})
    audit(db, actor.user_id, actor.role, "discharge.edd_updated", "discharge", discharge_id,
          {"expected_discharge_at": d["expected_discharge_at"]}, {"expected_discharge_at": expected}, "DISCHARGE_EDD_UPDATED", correlation_id)
    db.commit()
    return {"id": discharge_id, "expected_discharge_at": expected}


def _cancel_open_work(db: Session, actor: Actor, discharge_id: str, correlation_id: str, reason: str) -> None:
    db.execute(text(f"UPDATE {SCHEMA}.task SET status = 'CANCELLED', completed_at = now(), version = version + 1, updated_at = now()"
                    " WHERE discharge_id = CAST(:id AS uuid) AND status IN ('OPEN', 'CLAIMED')"), {"id": discharge_id})
    db.execute(text(f"UPDATE {SCHEMA}.blocker SET status = 'CANCELLED', resolved_at = now(), resolved_by = :by,"
                    " resolution_note = 'Discharge cancelled or reversed', version = version + 1, updated_at = now()"
                    " WHERE discharge_id = CAST(:id AS uuid) AND status = 'OPEN'"), {"id": discharge_id, "by": actor.user_id})


def _fan_out_default_tasks(db: Session, actor: Actor, discharge_id: str, ward_id: str, ward_code: str, correlation_id: str) -> None:
    # Work completed before a restart (e.g. med rec done before a 2 PM fever) is stale: only tasks that are
    # open, or were completed during the current attempt (since initiated_at), satisfy the checklist.
    existing = {r["type"] for r in _rows(db, f"""
        SELECT t.type FROM {SCHEMA}.task t JOIN {SCHEMA}.discharge d ON d.id = t.discharge_id
         WHERE t.discharge_id = CAST(:id AS uuid)
           AND (t.status IN ('OPEN', 'CLAIMED') OR (t.status = 'DONE' AND t.completed_at >= d.initiated_at))""", id=discharge_id)}
    for tpl in DEFAULT_TASK_TEMPLATES:
        if tpl.type not in existing:
            _insert_task(db, actor, discharge_id, ward_id, ward_code, tpl.type, tpl.title, tpl.owner_role,
                         _now() + timedelta(minutes=tpl.due_minutes), tpl.priority, True, None, "TEMPLATE", correlation_id)
    if "IM_FOLLOW_UP" not in existing:
        _schedule_im_follow_up(db, actor, discharge_id, ward_id, ward_code, correlation_id)


# ---------------------------------------------------------------- Important Message from Medicare (42 CFR 405.1205)
IM_INITIAL, IM_FOLLOW_UP = "IM_INITIAL", "IM_FOLLOW_UP"


def schedule_im_initial(db: Session, actor: Actor | None, encounter_id: str, ward_id: str, ward_code: str, correlation_id: str) -> str | None:
    """Medicare inpatients must receive the signed IM within 2 calendar days of admission."""
    enc = _row(db, f"SELECT patient_class, medicare, admitted_at FROM {SCHEMA}.encounter WHERE id = CAST(:e AS uuid)", e=encounter_id)
    if not enc or not enc["medicare"] or enc["patient_class"] != "I":
        return None
    if _row(db, f"SELECT 1 AS x FROM {SCHEMA}.task WHERE encounter_id = CAST(:e AS uuid) AND type = :t AND status <> 'CANCELLED'",
            e=encounter_id, t=IM_INITIAL):
        return None
    due = (enc["admitted_at"] or _now()) + timedelta(days=2)
    return _insert_task(db, actor, None, ward_id, ward_code, IM_INITIAL,
                        "Deliver Important Message from Medicare (initial, signed) — within 2 days of admission",
                        "case_manager", due, 2, True, None, "TEMPLATE", correlation_id, encounter_id=encounter_id)


def _schedule_im_follow_up(db: Session, actor: Actor | None, discharge_id: str, ward_id: str, ward_code: str, correlation_id: str) -> None:
    """Follow-up IM copy: no more than 2 days before discharge; at least 4 h before if the decision is late.

    Not needed when the initial IM was delivered within 2 days of the (expected) discharge.
    """
    d = _row(db, f"""SELECT d.encounter_id, d.expected_discharge_at, e.medicare, e.patient_class,
                            (SELECT max(t.completed_at) FROM {SCHEMA}.task t WHERE t.encounter_id = e.id AND t.type = :init AND t.status = 'DONE') AS initial_done_at
                       FROM {SCHEMA}.discharge d JOIN {SCHEMA}.encounter e ON e.id = d.encounter_id WHERE d.id = CAST(:id AS uuid)""",
             id=discharge_id, init=IM_INITIAL)
    if not d or not d["medicare"] or d["patient_class"] != "I":
        return
    discharge_at = d["expected_discharge_at"] or (_now() + timedelta(hours=24))
    if d["initial_done_at"] and discharge_at - d["initial_done_at"] <= timedelta(days=2):
        return
    due = max(discharge_at - timedelta(hours=4), _now() + timedelta(minutes=30))
    _insert_task(db, actor, discharge_id, ward_id, ward_code, IM_FOLLOW_UP,
                 "Deliver follow-up Important Message from Medicare — ≤2 days and ≥4 h before discharge",
                 "case_manager", due, 1, True, None, "TEMPLATE", correlation_id)


def _bed_label(db: Session, bed_id: Any) -> str:
    row = _row(db, f"SELECT label FROM {SCHEMA}.bed WHERE id = :id", id=str(bed_id))
    return row["label"] if row else "?"


def _set_bed_state(db: Session, actor: Actor | None, bed_id: str, target: str, reason: str, correlation_id: str) -> None:
    bed = _row(db, f"SELECT id, state::text AS state, version FROM {SCHEMA}.bed WHERE id = CAST(:id AS uuid) FOR UPDATE", id=bed_id)
    if not bed:
        raise DomainError("NOT_FOUND", "Bed not found", 404)
    if bed["state"] == target:
        return
    assert_bed_transition(bed["state"], target)
    db.execute(text(f"UPDATE {SCHEMA}.bed SET state = CAST(:s AS dischargeloop.bed_state),"
                    " state_reason_code = CAST(:r AS dischargeloop.reason_code), version = version + 1, updated_at = now()"
                    " WHERE id = CAST(:id AS uuid)"), {"s": target, "r": reason, "id": bed_id})
    audit(db, actor.user_id if actor else SYSTEM_ACTOR_ID, actor.role if actor else "system", f"bed.{target.lower()}", "bed", bed_id,
          {"state": bed["state"], "version": bed["version"]}, {"state": target, "version": bed["version"] + 1}, reason, correlation_id)
    outbox(db, "bed", bed_id, "BedStateChanged", {"from": bed["state"], "to": target, "reason": reason}, correlation_id)


# ---------------------------------------------------------------- tasks (feature 2)
def _insert_task(db: Session, actor: Actor | None, discharge_id: str | None, ward_id: str, ward_code: str, task_type: str, title: str,
                 owner_role: str, due_at: datetime, priority: int, blocking: bool, blocker_id: str | None, source: str,
                 correlation_id: str, encounter_id: str | None = None) -> str:
    if owner_role not in TASK_OWNER_ROLES:
        raise DomainError("INVALID_OWNER_ROLE", f"Tasks must be owned by a functional role, not '{owner_role}'", 400)
    task_id = _id()
    db.execute(text(
        f"INSERT INTO {SCHEMA}.task (id, discharge_id, encounter_id, type, title, owner_role, owner_ward_id, priority, blocking, due_at,"
        " blocker_id, source) VALUES (:id, :d, coalesce(CAST(:enc AS uuid), (SELECT encounter_id FROM dischargeloop.discharge WHERE id = CAST(:d AS uuid))),"
        " :type, :title, :owner, :ward, :prio, :blocking, :due, :blocker, :src)"),
        {"id": task_id, "d": discharge_id, "enc": encounter_id, "type": task_type[:48], "title": title[:160], "owner": owner_role, "ward": ward_id,
         "prio": priority, "blocking": blocking, "due": due_at, "blocker": blocker_id, "src": source})
    audit(db, actor.user_id if actor else SYSTEM_ACTOR_ID, actor.role if actor else "system", "task.created", "task", task_id, None,
          {"type": task_type, "owner": functional_role(owner_role, ward_code), "due_at": due_at, "source": source},
          "TASK_CREATED", correlation_id)
    return task_id


def create_task(db: Session, actor: Actor, discharge_id: str, task_type: str, title: str, owner_role: str,
                due_at: datetime, priority: int, blocking: bool, correlation_id: str) -> dict:
    actor.require(CAN_MANAGE_BLOCKERS, "create tasks")
    d = _discharge_for_update(db, discharge_id)
    if not actor.can_see_ward(str(d["ward_id"])):
        raise DomainError("NOT_FOUND", "Discharge not found", 404)
    if d["state"] not in ACTIVE_DISCHARGE_STATES:
        raise DomainError("DISCHARGE_NOT_ACTIVE", "Tasks can only be added to an active discharge")
    task_id = _insert_task(db, actor, discharge_id, str(d["ward_id"]), d["ward_code"], task_type, title, owner_role,
                           due_at, priority, blocking, None, "MANUAL", correlation_id)
    db.commit()
    return {"id": task_id}


def list_tasks(db: Session, actor: Actor, mine: bool, ward_id: str | None, include_done: bool = False) -> list[dict]:
    status_sql = "" if include_done else "AND t.status IN ('OPEN', 'CLAIMED')"
    mine_sql = "AND (t.owner_user_id = CAST(:me AS uuid) OR (t.owner_role = :role AND t.owner_user_id IS NULL))" if mine else ""
    return _rows(db, f"""
        SELECT t.id, t.discharge_id, t.type, t.title, t.owner_role || coalesce('@' || w.code, '') AS owner, t.owner_user_id,
               t.status::text AS status, t.priority, t.blocking, t.due_at, t.escalation_level, t.source, t.version,
               (t.status IN ('OPEN', 'CLAIMED') AND t.due_at < now()) AS overdue, w.code AS ward_code, b.label AS bed_label
          FROM {SCHEMA}.task t JOIN {SCHEMA}.encounter e ON e.id = t.encounter_id
          JOIN {SCHEMA}.ward w ON w.id = e.ward_id
          LEFT JOIN {SCHEMA}.bed b ON b.id = e.bed_id
         WHERE {SCOPE_SQL.format(col='e.ward_id')} {status_sql} {mine_sql}
           AND (CAST(:ward_id AS uuid) IS NULL OR e.ward_id = CAST(:ward_id AS uuid))
         ORDER BY t.due_at LIMIT 500""", me=actor.user_id, role=actor.role, ward_id=ward_id, **_scope_params(actor))


def act_on_task(db: Session, actor: Actor, task_id: str, action: str, correlation_id: str, system: bool = False) -> dict:
    t = _row(db, f"""SELECT t.*, t.status::text AS status, e.ward_id FROM {SCHEMA}.task t
                     JOIN {SCHEMA}.encounter e ON e.id = t.encounter_id
                     WHERE t.id = CAST(:id AS uuid) FOR UPDATE OF t""", id=task_id)
    if not t or (not system and not actor.can_see_ward(str(t["ward_id"]))):
        raise DomainError("NOT_FOUND", "Task not found", 404)
    if t["status"] in ("DONE", "CANCELLED"):
        raise DomainError("TASK_CLOSED", f"Task is already {t['status']}")
    owns = actor.role == t["owner_role"] or (t["owner_user_id"] and str(t["owner_user_id"]) == actor.user_id)
    # Claiming/completing is reserved for the owning role: a coordinator must never "complete" a physician's
    # signature or a pharmacist's reconciliation. Coordinators may cancel (e.g. no longer needed).
    if not system and action in ("claim", "complete") and not owns:
        raise DomainError("FORBIDDEN", f"Only {t['owner_role']} can {action} this task", 403)
    if action == "claim":
        db.execute(text(f"UPDATE {SCHEMA}.task SET status = 'CLAIMED', owner_user_id = :me, version = version + 1, updated_at = now()"
                        " WHERE id = CAST(:id AS uuid)"), {"me": actor.user_id, "id": task_id})
        new_status, reason = "CLAIMED", "TASK_CLAIMED"
    elif action in ("complete", "cancel"):
        if action == "cancel" and not system and actor.role not in CAN_MANAGE_ANY_TASK:
            raise DomainError("FORBIDDEN", "Only a coordinator can cancel a task", 403)
        new_status = "DONE" if action == "complete" else "CANCELLED"
        reason = ("TASK_AUTO_COMPLETED" if system else "TASK_COMPLETED") if action == "complete" else "TASK_CANCELLED"
        db.execute(text(f"UPDATE {SCHEMA}.task SET status = CAST(:s AS dischargeloop.task_status), completed_at = now(),"
                        " version = version + 1, updated_at = now() WHERE id = CAST(:id AS uuid)"), {"s": new_status, "id": task_id})
    else:
        raise DomainError("INVALID_ACTION", f"Unknown task action {action}", 400)
    audit(db, actor.user_id, actor.role, f"task.{action}", "task", task_id, {"status": t["status"]}, {"status": new_status}, reason, correlation_id)
    outbox(db, "task", task_id, f"Task{new_status.title()}", {"dischargeId": str(t["discharge_id"]) if t["discharge_id"] else None,
                                                                         "encounterId": str(t["encounter_id"]), "status": new_status}, correlation_id)
    db.commit()
    return {"id": task_id, "status": new_status}


# ---------------------------------------------------------------- blockers (feature 3)
def open_blocker(db: Session, actor: Actor, discharge_id: str, category: str, description: str, correlation_id: str,
                 side: str | None = None, external_party: str | None = None, owner_role: str | None = None,
                 due_minutes: int = 240) -> dict:
    actor.require(CAN_MANAGE_BLOCKERS, "open blockers")
    if category not in DEFAULT_BLOCKER_SIDE:
        raise DomainError("INVALID_CATEGORY", f"Unknown blocker category {category}", 400)
    side = side or DEFAULT_BLOCKER_SIDE[category]
    owner_role = owner_role or DEFAULT_BLOCKER_OWNER[category]
    if side == "EXTERNAL" and not (external_party or "").strip():
        raise DomainError("EXTERNAL_PARTY_REQUIRED", "Name the external party (facility, payer, vendor, family)", 400)
    d = _discharge_for_update(db, discharge_id)
    if not actor.can_see_ward(str(d["ward_id"])):
        raise DomainError("NOT_FOUND", "Discharge not found", 404)
    if d["state"] not in ACTIVE_DISCHARGE_STATES:
        raise DomainError("DISCHARGE_NOT_ACTIVE", "Blockers can only be added to an active discharge")
    blocker_id = _id()
    db.execute(text(
        f"INSERT INTO {SCHEMA}.blocker (id, discharge_id, category, side, description, external_party, owner_role, owner_ward_id, opened_by)"
        " VALUES (:id, :d, CAST(:cat AS dischargeloop.blocker_category), CAST(:side AS dischargeloop.blocker_side), :desc, :party,"
        " :owner, :ward, :by)"),
        {"id": blocker_id, "d": discharge_id, "cat": category, "side": side, "desc": description.strip()[:280],
         "party": (external_party or "").strip()[:160] or None, "owner": owner_role, "ward": str(d["ward_id"]), "by": actor.user_id})
    task_id = _insert_task(db, actor, discharge_id, str(d["ward_id"]), d["ward_code"], f"BLOCKER_{category}"[:48],
                           f"Resolve: {description.strip()}"[:160], owner_role, _now() + timedelta(minutes=due_minutes), 2,
                           True, blocker_id, "MANUAL", correlation_id)
    audit(db, actor.user_id, actor.role, "blocker.opened", "blocker", blocker_id, None,
          {"category": category, "side": side, "external_party": external_party, "owner": owner_role}, "BLOCKER_OPENED", correlation_id)
    outbox(db, "blocker", blocker_id, "BlockerOpened", {"dischargeId": discharge_id, "category": category, "side": side}, correlation_id)
    db.commit()
    return {"id": blocker_id, "task_id": task_id, "side": side, "owner_role": owner_role}


def close_blocker(db: Session, actor: Actor, blocker_id: str, action: str, note: str | None, correlation_id: str) -> dict:
    b = _row(db, f"""SELECT bl.*, bl.status::text AS status, e.ward_id FROM {SCHEMA}.blocker bl
                     JOIN {SCHEMA}.discharge d ON d.id = bl.discharge_id JOIN {SCHEMA}.encounter e ON e.id = d.encounter_id
                     WHERE bl.id = CAST(:id AS uuid) FOR UPDATE OF bl""", id=blocker_id)
    if not b or not actor.can_see_ward(str(b["ward_id"])):
        raise DomainError("NOT_FOUND", "Blocker not found", 404)
    if b["status"] != "OPEN":
        raise DomainError("BLOCKER_CLOSED", f"Blocker is already {b['status']}")
    if actor.role != b["owner_role"] and actor.role not in CAN_MANAGE_BLOCKERS:
        raise DomainError("FORBIDDEN", "Only the owner role or a coordinator can close this blocker", 403)
    status = "RESOLVED" if action == "resolve" else "CANCELLED"
    db.execute(text(f"UPDATE {SCHEMA}.blocker SET status = CAST(:s AS dischargeloop.blocker_status), resolved_at = now(),"
                    " resolved_by = :by, resolution_note = :note, version = version + 1, updated_at = now() WHERE id = CAST(:id AS uuid)"),
               {"s": status, "by": actor.user_id, "note": (note or "")[:280] or None, "id": blocker_id})
    task_status = "DONE" if status == "RESOLVED" else "CANCELLED"
    db.execute(text(f"UPDATE {SCHEMA}.task SET status = CAST(:s AS dischargeloop.task_status), completed_at = now(), version = version + 1,"
                    " updated_at = now() WHERE blocker_id = CAST(:id AS uuid) AND status IN ('OPEN', 'CLAIMED')"), {"s": task_status, "id": blocker_id})
    audit(db, actor.user_id, actor.role, f"blocker.{action}", "blocker", blocker_id, {"status": "OPEN"}, {"status": status, "note": note},
          "BLOCKER_RESOLVED" if status == "RESOLVED" else "BLOCKER_CANCELLED", correlation_id)
    outbox(db, "blocker", blocker_id, f"Blocker{status.title()}", {"dischargeId": str(b["discharge_id"])}, correlation_id)
    db.commit()
    return {"id": blocker_id, "status": status}


# ---------------------------------------------------------------- beds, admissions, reservations, cleaning
def list_beds(db: Session, actor: Actor, ward_id: str | None) -> list[dict]:
    return _rows(db, f"""
        SELECT b.id, b.label, b.state::text AS state, b.state_reason_code::text AS reason, b.version, w.id AS ward_id, w.code AS ward_code,
               e.id AS encounter_id, d.state::text AS discharge_state,
               (SELECT a.expires_at FROM {SCHEMA}.bed_assignment a WHERE a.bed_id = b.id AND a.kind = 'RESERVATION' AND a.state = 'ACTIVE') AS reserved_until
          FROM {SCHEMA}.bed b JOIN {SCHEMA}.ward w ON w.id = b.ward_id
          LEFT JOIN {SCHEMA}.encounter e ON e.bed_id = b.id AND e.status = 'ADMITTED'
          LEFT JOIN {SCHEMA}.discharge d ON d.encounter_id = e.id
         WHERE {SCOPE_SQL.format(col='b.ward_id')} AND (CAST(:ward_id AS uuid) IS NULL OR b.ward_id = CAST(:ward_id AS uuid))
         ORDER BY w.code, b.label""", ward_id=ward_id, **_scope_params(actor))


def upsert_patient(db: Session, hospital_id: str, mrn: str, display_name: str, dob: Any = None, sex: str | None = None) -> str:
    row = _row(db, f"""INSERT INTO {SCHEMA}.patient (id, hospital_id, his_patient_id, display_name, date_of_birth, sex)
                       VALUES (:id, :h, :mrn, :name, :dob, :sex)
                       ON CONFLICT (hospital_id, his_patient_id) DO UPDATE SET display_name = EXCLUDED.display_name,
                         date_of_birth = coalesce(EXCLUDED.date_of_birth, {SCHEMA}.patient.date_of_birth),
                         sex = coalesce(EXCLUDED.sex, {SCHEMA}.patient.sex), updated_at = now()
                       RETURNING id""", id=_id(), h=hospital_id, mrn=mrn[:128], name=display_name[:180], dob=dob, sex=(sex or None))
    return str(row["id"])


def admit(db: Session, actor: Actor | None, patient_id: str, ward_id: str, bed_id: str | None, his_encounter_id: str,
          correlation_id: str, commit: bool = True, patient_class: str = "I", medicare: bool = False,
          event_at: datetime | None = None) -> str:
    if actor:
        actor.require(CAN_RESERVE | CAN_INITIATE, "admit patients")
        if not actor.can_see_ward(ward_id):
            raise DomainError("FORBIDDEN", "Ward is outside your access scope", 403)
    if bed_id:
        bed = _row(db, f"SELECT ward_id FROM {SCHEMA}.bed WHERE id = CAST(:id AS uuid)", id=bed_id)
        if not bed or str(bed["ward_id"]) != str(ward_id):
            raise DomainError("BED_WARD_MISMATCH", "Bed does not belong to the ward", 400)
        db.execute(text(f"UPDATE {SCHEMA}.bed_assignment SET state = 'ENDED', ended_at = now(), updated_at = now()"
                        " WHERE bed_id = CAST(:bed AS uuid) AND kind = 'RESERVATION' AND state = 'ACTIVE'"), {"bed": bed_id})
        _set_bed_state(db, actor, bed_id, "OCCUPIED", "ADMISSION_CONFIRMED", correlation_id)
    encounter_id = _id()
    db.execute(text(f"INSERT INTO {SCHEMA}.encounter (id, patient_id, ward_id, bed_id, status, his_encounter_id, admitted_at,"
                    " patient_class, medicare, last_adt_at) VALUES (:id, :p, :w, :b, 'ADMITTED', :his, now(), :cls, :mc, :evt)"),
               {"id": encounter_id, "p": patient_id, "w": ward_id, "b": bed_id, "his": his_encounter_id[:128],
                "cls": (patient_class or "I")[:8], "mc": medicare, "evt": event_at})
    if bed_id:
        db.execute(text(f"INSERT INTO {SCHEMA}.bed_assignment (id, bed_id, encounter_id, kind, state, starts_at, created_by)"
                        " VALUES (:id, :b, :e, 'OCCUPANCY', 'ACTIVE', now(), :by)"),
                   {"id": _id(), "b": bed_id, "e": encounter_id, "by": actor.user_id if actor else None})
    audit(db, actor.user_id if actor else SYSTEM_ACTOR_ID, actor.role if actor else "system", "encounter.admitted", "encounter",
          encounter_id, None, {"ward_id": ward_id, "bed_id": bed_id}, "ENCOUNTER_ADMITTED", correlation_id)
    outbox(db, "encounter", encounter_id, "PatientAdmitted", {"wardId": ward_id, "bedId": bed_id}, correlation_id)
    ward_code = _row(db, f"SELECT code FROM {SCHEMA}.ward WHERE id = CAST(:w AS uuid)", w=ward_id)["code"]
    schedule_im_initial(db, actor, encounter_id, ward_id, ward_code, correlation_id)
    if commit:
        db.commit()
    return encounter_id


def reserve_bed(db: Session, actor: Actor, bed_id: str, ttl_minutes: int, correlation_id: str) -> dict:
    actor.require(CAN_RESERVE, "reserve beds")
    bed = _row(db, f"SELECT ward_id FROM {SCHEMA}.bed WHERE id = CAST(:id AS uuid)", id=bed_id)
    if not bed or not actor.can_see_ward(str(bed["ward_id"])):
        raise DomainError("NOT_FOUND", "Bed not found", 404)
    _set_bed_state(db, actor, bed_id, "RESERVED", "RESERVATION_REQUESTED", correlation_id)
    assignment_id = _id()
    expires = _now() + timedelta(minutes=max(5, min(ttl_minutes, 24 * 60)))
    db.execute(text(f"INSERT INTO {SCHEMA}.bed_assignment (id, bed_id, kind, state, starts_at, expires_at, created_by)"
                    " VALUES (:id, :b, 'RESERVATION', 'ACTIVE', now(), :exp, :by)"),
               {"id": assignment_id, "b": bed_id, "exp": expires, "by": actor.user_id})
    db.commit()
    return {"reservation_id": assignment_id, "expires_at": expires}


def release_reservation(db: Session, actor: Actor | None, bed_id: str, correlation_id: str, expired: bool = False) -> None:
    db.execute(text(f"UPDATE {SCHEMA}.bed_assignment SET state = CAST(:s AS dischargeloop.assignment_state), ended_at = now(),"
                    " updated_at = now() WHERE bed_id = CAST(:b AS uuid) AND kind = 'RESERVATION' AND state = 'ACTIVE'"),
               {"s": "EXPIRED" if expired else "CANCELLED", "b": bed_id})
    _set_bed_state(db, actor, bed_id, "AVAILABLE", "RESERVATION_EXPIRED" if expired else "RESERVATION_CANCELLED", correlation_id)


def expire_reservations(db: Session, correlation_id: str) -> int:
    beds = _rows(db, f"SELECT bed_id FROM {SCHEMA}.bed_assignment WHERE kind = 'RESERVATION' AND state = 'ACTIVE' AND expires_at < now()"
                     " FOR UPDATE SKIP LOCKED")
    for b in beds:
        release_reservation(db, None, str(b["bed_id"]), correlation_id, expired=True)
    db.commit()
    return len(beds)


def list_cleaning(db: Session, actor: Actor) -> list[dict]:
    return _rows(db, f"""SELECT c.id, c.status::text AS status, c.requested_at, c.accepted_by, c.accepted_at, b.id AS bed_id, b.label AS bed_label,
                                w.code AS ward_code FROM {SCHEMA}.cleaning c JOIN {SCHEMA}.bed b ON b.id = c.bed_id
                                JOIN {SCHEMA}.ward w ON w.id = b.ward_id
                          WHERE c.status <> 'VERIFIED' AND {SCOPE_SQL.format(col='b.ward_id')} ORDER BY c.requested_at""",
                 **_scope_params(actor))


def act_on_cleaning(db: Session, actor: Actor, cleaning_id: str, action: str, correlation_id: str) -> dict:
    actor.require(CAN_CLEAN, f"{action} cleaning")
    c = _row(db, f"""SELECT c.*, c.status::text AS status, b.ward_id FROM {SCHEMA}.cleaning c JOIN {SCHEMA}.bed b ON b.id = c.bed_id
                     WHERE c.id = CAST(:id AS uuid) FOR UPDATE OF c""", id=cleaning_id)
    if not c or not actor.can_see_ward(str(c["ward_id"])):
        raise DomainError("NOT_FOUND", "Cleaning job not found", 404)
    if action == "accept":
        if c["status"] != "OPEN":
            raise DomainError("CLEANING_STATE", f"Cleaning is {c['status']}, expected OPEN")
        db.execute(text(f"UPDATE {SCHEMA}.cleaning SET status = 'ACCEPTED', accepted_by = :me, accepted_at = now(), updated_at = now()"
                        " WHERE id = CAST(:id AS uuid)"), {"me": actor.user_id, "id": cleaning_id})
        reason = "CLEANING_ACCEPTED"
    elif action == "verify":
        if c["status"] != "ACCEPTED":
            raise DomainError("CLEANING_STATE", f"Cleaning is {c['status']}, expected ACCEPTED")
        if str(c["accepted_by"]) == actor.user_id:
            raise DomainError("SECOND_PERSON_REQUIRED", "A different person must verify the cleaning", 409)
        db.execute(text(f"UPDATE {SCHEMA}.cleaning SET status = 'VERIFIED', verified_by = :me, verified_at = now(), updated_at = now()"
                        " WHERE id = CAST(:id AS uuid)"), {"me": actor.user_id, "id": cleaning_id})
        # Human-confirmed physical readiness is the only path from CLEANING back to AVAILABLE.
        _set_bed_state(db, actor, str(c["bed_id"]), "AVAILABLE", "CLEANING_VERIFIED", correlation_id)
        reason = "CLEANING_VERIFIED"
    else:
        raise DomainError("INVALID_ACTION", f"Unknown cleaning action {action}", 400)
    audit(db, actor.user_id, actor.role, f"cleaning.{action}", "cleaning", cleaning_id, {"status": c["status"]},
          {"status": "ACCEPTED" if action == "accept" else "VERIFIED"}, reason, correlation_id)
    db.commit()
    return {"id": cleaning_id, "action": action}


# ---------------------------------------------------------------- notifications (feature 4 delivery)
def list_notifications(db: Session, actor: Actor, unread_only: bool) -> list[dict]:
    unread_sql = "AND n.read_at IS NULL" if unread_only else ""
    return _rows(db, f"""SELECT n.id, n.kind, n.severity, n.title, n.body, n.entity_type, n.entity_id, n.created_at, n.read_at,
                                w.code AS ward_code FROM {SCHEMA}.notification n LEFT JOIN {SCHEMA}.ward w ON w.id = n.recipient_ward_id
                          WHERE n.recipient_role = :role AND (n.recipient_ward_id IS NULL OR {SCOPE_SQL.format(col='n.recipient_ward_id')})
                          {unread_sql} ORDER BY n.created_at DESC LIMIT 100""", role=actor.role, **_scope_params(actor))


def mark_notification_read(db: Session, actor: Actor, notification_id: str) -> None:
    db.execute(text(f"UPDATE {SCHEMA}.notification SET read_at = now(), read_by = :me WHERE id = CAST(:id AS uuid)"
                    " AND recipient_role = :role AND read_at IS NULL"), {"me": actor.user_id, "id": notification_id, "role": actor.role})
    db.commit()


def get_user_wards(db: Session, actor: Actor, user_id: str) -> list[dict]:
    actor.require(frozenset({"system_admin", "hospital_admin"}), "view staff ward assignments")
    return _rows(db, f"""SELECT w.id AS ward_id, w.code, w.name FROM {SCHEMA}.user_ward_scope s JOIN {SCHEMA}.ward w ON w.id = s.ward_id
                          WHERE s.user_id = CAST(:u AS uuid) ORDER BY w.code""", u=user_id)


def set_user_wards(db: Session, actor: Actor, user_id: str, ward_ids: list[str], correlation_id: str) -> list[dict]:
    """Minimum-necessary access: non-hospital-wide staff only see patients on wards assigned here."""
    actor.require(frozenset({"system_admin", "hospital_admin"}), "assign staff to wards")
    if not _row(db, "SELECT 1 AS x FROM medsync.app_users WHERE user_id = CAST(:u AS uuid)", u=user_id):
        raise DomainError("NOT_FOUND", "User not found", 404)
    wanted = sorted(set(ward_ids))
    known = {str(r["id"]) for r in _rows(db, f"SELECT id FROM {SCHEMA}.ward WHERE id = ANY(CAST(:w AS uuid[]))", w=wanted)}
    if unknown := [w for w in wanted if w not in known]:
        raise DomainError("UNKNOWN_WARD", f"Unknown ward id(s): {', '.join(unknown)}", 400)
    before = [str(r["ward_id"]) for r in get_user_wards(db, actor, user_id)]
    db.execute(text(f"DELETE FROM {SCHEMA}.user_ward_scope WHERE user_id = CAST(:u AS uuid)"), {"u": user_id})
    for ward_id in wanted:
        db.execute(text(f"INSERT INTO {SCHEMA}.user_ward_scope (user_id, ward_id) VALUES (:u, :w)"), {"u": user_id, "w": ward_id})
    audit(db, actor.user_id, actor.role, "user.wards_assigned", "user", user_id, {"ward_ids": before}, {"ward_ids": wanted},
          "CREATED", correlation_id)
    db.commit()
    return get_user_wards(db, actor, user_id)


def audit_trail(db: Session, actor: Actor, limit: int) -> list[dict]:
    actor.require(frozenset({"system_admin", "hospital_admin", "operations_manager"}), "view the audit trail")
    return _rows(db, f"""SELECT occurred_at, actor_id, actor_role, action, entity_type, entity_id, reason_code::text AS reason_code
                          FROM {SCHEMA}.audit_event ORDER BY occurred_at DESC LIMIT :limit""", limit=max(1, min(limit, 500)))


def metrics(db: Session, actor: Actor) -> dict:
    """Operational measures the hospital buys on: ready-to-depart delay and delay by blocker category."""
    params = _scope_params(actor)
    ready_delay = _row(db, f"""SELECT count(*) AS departed, round(avg(extract(epoch FROM d.departed_at - d.cleared_at)) / 3600, 1) AS avg_hours_cleared_to_departed
                                 FROM {SCHEMA}.discharge d JOIN {SCHEMA}.encounter e ON e.id = d.encounter_id
                                WHERE d.state = 'DEPARTED' AND d.cleared_at IS NOT NULL AND {SCOPE_SQL.format(col='e.ward_id')}""", **params)
    by_category = _rows(db, f"""SELECT bl.category::text AS category, bl.side::text AS side, count(*) AS total,
                                   count(*) FILTER (WHERE bl.status = 'OPEN') AS open,
                                   round(avg(extract(epoch FROM coalesce(bl.resolved_at, now()) - bl.opened_at)) / 3600, 1) AS avg_hours_open
                              FROM {SCHEMA}.blocker bl JOIN {SCHEMA}.discharge d ON d.id = bl.discharge_id
                              JOIN {SCHEMA}.encounter e ON e.id = d.encounter_id
                             WHERE {SCOPE_SQL.format(col='e.ward_id')} GROUP BY 1, 2 ORDER BY total DESC""", **params)
    return {"ready_delay": ready_delay, "blockers_by_category": by_category}
