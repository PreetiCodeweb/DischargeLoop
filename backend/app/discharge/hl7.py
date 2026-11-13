"""Feature 5: HL7 v2 ingestion from the hospital interface engine (Epic Bridges -> Mirth/Redox -> HTTPS).

Read-light: DischargeLoop never writes back to the EHR. Every message is logged once (idempotent on
MSH-10), processed in one transaction, and answered with an HL7 ACK (AA / AE / AR).
"""
from __future__ import annotations

import json
import os
import re
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.discharge import service as svc
from app.discharge.domain import ACTIVE_DISCHARGE_STATES, SYSTEM_ROLE, Actor, DomainError

SYSTEM_ACTOR = Actor(user_id=svc.SYSTEM_ACTOR_ID, role=SYSTEM_ROLE, email="hl7@system", full_name="EHR interface", ward_ids=None)
S = svc.SCHEMA


class HL7Error(Exception):
    pass


@dataclass
class HL7Message:
    segments: dict[str, list[list[str]]]
    raw: str

    def field(self, seg: str, n: int, comp: int = 1, rep: int = 0) -> str:
        rows = self.segments.get(seg)
        if not rows:
            return ""
        fields = rows[rep]
        idx = n - 1 if seg == "MSH" else n  # MSH-1 is the field separator itself
        if idx >= len(fields):
            return ""
        value = fields[idx].split("~")[0]
        parts = value.split("^")
        return parts[comp - 1].strip() if comp - 1 < len(parts) else ""

    @property
    def message_type(self) -> str:
        return self.field("MSH", 9, 1)

    @property
    def trigger(self) -> str:
        return self.field("MSH", 9, 2)

    @property
    def control_id(self) -> str:
        return self.field("MSH", 10)

    @property
    def source_system(self) -> str:
        return self.field("MSH", 3) or "EHR"


def parse(raw: str) -> HL7Message:
    text_ = raw.replace("\r\n", "\r").replace("\n", "\r").strip().lstrip("\x0b").rstrip("\x1c")
    segments: dict[str, list[list[str]]] = {}
    for line in filter(None, (s.strip() for s in text_.split("\r"))):
        fields = line.split("|")
        segments.setdefault(fields[0], []).append(fields)
    if "MSH" not in segments or not segments["MSH"][0][1:2]:
        raise HL7Error("Message must start with an MSH segment")
    return HL7Message(segments, raw)


# HL7 TS values without an explicit offset are in the sending facility's local time (e.g. America/New_York),
# not UTC. Set per message from hospital.timezone; a ContextVar keeps API threads and MLLP tasks independent.
_SENDER_TZ: ContextVar[tzinfo] = ContextVar("hl7_sender_tz", default=timezone.utc)


def _hl7_datetime(value: str) -> datetime | None:
    value = value.strip()
    match = re.match(r"^(\d{8,14})(?:\.\d+)?([+-]\d{4})?$", value)
    if not match:
        return None
    digits, offset = match.groups()
    for fmt, size in (("%Y%m%d%H%M%S", 14), ("%Y%m%d%H%M", 12), ("%Y%m%d", 8)):
        if len(digits) >= size:
            try:
                naive = datetime.strptime(digits[:size], fmt)
            except ValueError:
                return None
            if offset:
                sign = 1 if offset[0] == "+" else -1
                tz: tzinfo = timezone(sign * timedelta(hours=int(offset[1:3]), minutes=int(offset[3:5])))
            else:
                tz = _SENDER_TZ.get()
            return naive.replace(tzinfo=tz).astimezone(timezone.utc)
    return None


def _hl7_date(value: str) -> date | None:
    dt = _hl7_datetime(value)
    return dt.date() if dt else None


def ack(msg: HL7Message | None, code: str, note: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    send_app = msg.field("MSH", 3) if msg else ""
    send_fac = msg.field("MSH", 4) if msg else ""
    trigger = msg.trigger if msg else ""
    control = msg.control_id if msg else ""
    note = note.replace("|", "/").replace("\r", " ")[:200]
    return f"MSH|^~\\&|DISCHARGELOOP|DISCHARGELOOP|{send_app}|{send_fac}|{ts}||ACK^{trigger}|{uuid.uuid4().hex[:20]}|P|2.5.1\rMSA|{code}|{control}|{note}\r"


def _event_type(msg: HL7Message) -> str:
    if msg.message_type == "ADT":
        return f"ADT_{msg.trigger}"
    return msg.message_type  # ORU / ORM / RDE


SUPPORTED = {"ADT_A01", "ADT_A02", "ADT_A03", "ADT_A04", "ADT_A05", "ADT_A06", "ADT_A07", "ADT_A08", "ADT_A11", "ADT_A12",
             "ADT_A13", "ADT_A16", "ADT_A17", "ADT_A21", "ADT_A22", "ADT_A25", "ADT_A34", "ADT_A40", "ORU", "ORM", "RDE"}
# Events that change an existing encounter; these are subject to the out-of-order guard.
ENCOUNTER_EVENTS = {"ADT_A02", "ADT_A03", "ADT_A06", "ADT_A07", "ADT_A08", "ADT_A11", "ADT_A16", "ADT_A21", "ADT_A22", "ADT_A25"}


def _event_time(msg: HL7Message) -> datetime | None:
    """EVN-2 (recorded date/time), falling back to MSH-7. Used to order late/replayed messages."""
    return _hl7_datetime(msg.field("EVN", 2)) or _hl7_datetime(msg.field("MSH", 7))


def _is_medicare(msg: HL7Message) -> bool:
    """Medicare FFS or Medicare Advantage coverage on any IN1 repetition (plan id, company name or plan type)."""
    for rep in range(len(msg.segments.get("IN1", []))):
        text_ = " ".join(msg.field("IN1", n, 1, rep) for n in (2, 4, 15)).upper()
        if "MEDICARE" in text_ or msg.field("IN1", 15, 1, rep).upper() in ("MC", "MA", "MCR"):
            return True
    return False


def _patient_class(msg: HL7Message, rep: int = 0, default: str = "I") -> str:
    return (msg.field("PV1", 2, 1, rep) or default).upper()[:8]


def _hospital_id(db: Session) -> str:
    row = svc._row(db, f"SELECT id FROM {S}.hospital ORDER BY is_primary DESC LIMIT 1")
    if not row:
        raise HL7Error("No hospital configured")
    return str(row["id"])


def _resolve_location(db: Session, msg: HL7Message) -> tuple[str, str | None]:
    poc, room, bed = msg.field("PV1", 3, 1), msg.field("PV1", 3, 2), msg.field("PV1", 3, 3)
    mapped = svc._row(db, f"SELECT ward_id, bed_id FROM {S}.hl7_location_map WHERE source_system = :src AND point_of_care = :poc"
                          " AND room = :room AND bed = :bed", src=msg.source_system, poc=poc, room=room, bed=bed)
    if mapped:
        return str(mapped["ward_id"]), str(mapped["bed_id"]) if mapped["bed_id"] else None
    ward = svc._row(db, f"SELECT id FROM {S}.ward WHERE code = :code AND is_active", code=poc)
    if not ward:
        raise DomainError("UNKNOWN_LOCATION", f"No ward mapped for PV1-3 point of care '{poc}'", 422)
    candidates = [c for c in (bed, f"{room}-{bed}" if room and bed else "", room) if c]
    for label in candidates:
        b = svc._row(db, f"SELECT id FROM {S}.bed WHERE ward_id = :w AND label = :l", w=str(ward["id"]), l=label)
        if b:
            return str(ward["id"]), str(b["id"])
    return str(ward["id"]), None


def _encounter(db: Session, msg: HL7Message, rep: int = 0) -> dict | None:
    visit = msg.field("PV1", 19, 1, rep)
    if not visit:
        return None
    return svc._row(db, f"""SELECT e.id, e.ward_id, e.bed_id, e.status::text AS status, e.patient_id, e.patient_class, e.medicare,
                                   e.last_adt_at, w.code AS ward_code
                              FROM {S}.encounter e JOIN {S}.ward w ON w.id = e.ward_id
                             WHERE e.his_encounter_id = :v FOR UPDATE OF e""", v=visit)


def _upsert_patient_from(db: Session, hospital_id: str, msg: HL7Message, rep: int = 0) -> str:
    # Newborns and unidentified trauma patients often arrive without a name; never reject them.
    name = " ".join(filter(None, [msg.field("PID", 5, 2, rep), msg.field("PID", 5, 1, rep)])) or "Unidentified patient"
    return svc.upsert_patient(db, hospital_id, msg.field("PID", 3, 1, rep) or "UNKNOWN", name,
                              _hl7_date(msg.field("PID", 7, 1, rep)), msg.field("PID", 8, 1, rep) or None)


def _quarantine(db: Session, msg: HL7Message, reason: str) -> None:
    db.execute(text(f"INSERT INTO {S}.integration_quarantine (id, source_system, raw_payload, reason) VALUES (:id, :src, CAST(:raw AS jsonb), :r)"),
               {"id": str(uuid.uuid4()), "src": msg.source_system, "raw": json.dumps({"raw": msg.raw}), "r": reason[:80]})


def _ehr_departure(db: Session, enc: dict, cid: str, departed_at: datetime | None) -> None:
    """A03 is authoritative: the patient has left, even if tasks were still open in DischargeLoop."""
    d = svc._row(db, f"SELECT id, state::text AS state FROM {S}.discharge WHERE encounter_id = :e FOR UPDATE", e=enc["id"])
    if d and d["state"] == "DEPARTED":
        return
    if not d:
        did = str(uuid.uuid4())
        db.execute(text(f"INSERT INTO {S}.discharge (id, encounter_id, state, initiated_by, source) VALUES (:id, :e, 'INITIATED', :by, 'HL7_A16')"),
                   {"id": did, "e": enc["id"], "by": svc.SYSTEM_ACTOR_ID})
        d = {"id": did, "state": "INITIATED"}
    svc._cancel_open_work(db, SYSTEM_ACTOR, str(d["id"]), cid, "TASK_CANCELLED")
    db.execute(text(f"UPDATE {S}.discharge SET state = 'DEPARTED', departed_at = coalesce(:t, now()), cancelled_reason_code = NULL,"
                    " version = version + 1, updated_at = now() WHERE id = :id"), {"t": departed_at, "id": d["id"]})
    db.execute(text(f"UPDATE {S}.encounter SET status = 'DEPARTED', departed_at = coalesce(:t, now()), version = version + 1, updated_at = now()"
                    " WHERE id = :id"), {"t": departed_at, "id": enc["id"]})
    if enc["bed_id"]:
        _vacate_bed(db, str(enc["bed_id"]), cid)
    svc.audit(db, svc.SYSTEM_ACTOR_ID, SYSTEM_ROLE, "discharge.departed", "discharge", str(d["id"]), {"state": d["state"]},
              {"state": "DEPARTED", "source": "HL7_A03"}, "DISCHARGE_DEPARTED", cid)
    svc.outbox(db, "discharge", str(d["id"]), "PatientDeparted", {"encounterId": str(enc["id"]), "source": "HL7_A03"}, cid)


def _vacate_bed(db: Session, bed_id: str, cid: str) -> None:
    svc._set_bed_state(db, None, bed_id, "CLEANING", "PATIENT_DEPARTED", cid)
    db.execute(text(f"UPDATE {S}.bed_assignment SET state = 'ENDED', ended_at = now(), updated_at = now()"
                    " WHERE bed_id = :b AND kind = 'OCCUPANCY' AND state = 'ACTIVE'"), {"b": bed_id})
    exists = svc._row(db, f"SELECT 1 AS x FROM {S}.cleaning WHERE bed_id = :b AND status <> 'VERIFIED'", b=bed_id)
    if not exists:
        db.execute(text(f"INSERT INTO {S}.cleaning (id, bed_id) VALUES (:id, :b)"), {"id": str(uuid.uuid4()), "b": bed_id})


def _process(db: Session, msg: HL7Message, event: str, cid: str) -> tuple[str, str]:
    if event in ("ORU", "ORM", "RDE"):
        enc = _encounter(db, msg)
        if not enc:
            return "PROCESSED", "No DischargeLoop encounter for this visit; ignored"
        code = msg.field("OBR", 4) if event in ("ORU", "ORM") else msg.field("RXE", 2)
        rules = svc._rows(db, f"SELECT task_type FROM {S}.hl7_task_rule WHERE is_active AND event_type = CAST(:e AS {S}.hl7_event_type)"
                              " AND match_code IN ('*', :c)", e=event, c=code)
        types = [r["task_type"] for r in rules]
        tasks = svc._rows(db, f"SELECT t.id FROM {S}.task t WHERE t.encounter_id = :e"
                              " AND t.type = ANY(CAST(:types AS text[])) AND t.status IN ('OPEN', 'CLAIMED')", e=enc["id"], types=types)
        for t in tasks:
            svc.act_on_task(db, SYSTEM_ACTOR, str(t["id"]), "complete", cid, system=True)
        return "PROCESSED", f"Auto-completed {len(tasks)} task(s)"

    hospital_id = _hospital_id(db)
    if event in ("ADT_A34", "ADT_A40"):
        return _merge_patients(db, msg, hospital_id, cid)
    if event == "ADT_A17":
        return _swap_beds(db, msg, cid)
    enc = _encounter(db, msg)
    event_at = _event_time(msg)
    if enc and event in ENCOUNTER_EVENTS and event_at and enc["last_adt_at"] and event_at < enc["last_adt_at"]:
        # Interface-engine replay or post-downtime BCA reconciliation can deliver older events late.
        # Applying them would move the patient backwards (e.g. re-admit after discharge), so they are logged only.
        return "PROCESSED", f"Stale event ignored (event {event_at.isoformat()} older than last applied {enc['last_adt_at'].isoformat()})"
    status, note = _apply_adt(db, msg, event, enc, hospital_id, cid)
    if enc and event_at:
        db.execute(text(f"UPDATE {S}.encounter SET last_adt_at = greatest(coalesce(last_adt_at, :t), :t) WHERE id = :id"),
                   {"t": event_at, "id": enc["id"]})
    return status, note


def _merge_patients(db: Session, msg: HL7Message, hospital_id: str, cid: str) -> tuple[str, str]:
    """A40/A34: PID-3 is the surviving MRN, MRG-1 the retired one. Auto-apply only when unambiguous."""
    surviving_mrn, retired_mrn = msg.field("PID", 3), msg.field("MRG", 1)
    if not surviving_mrn or not retired_mrn:
        raise DomainError("MERGE_INCOMPLETE", "A40/A34 requires PID-3 and MRG-1", 422)
    retired = svc._row(db, f"SELECT id FROM {S}.patient WHERE hospital_id = :h AND his_patient_id = :m FOR UPDATE", h=hospital_id, m=retired_mrn)
    if not retired:
        return "PROCESSED", "Retired MRN not known to DischargeLoop; nothing to merge"
    surviving = svc._row(db, f"SELECT id FROM {S}.patient WHERE hospital_id = :h AND his_patient_id = :m FOR UPDATE", h=hospital_id, m=surviving_mrn)
    if not surviving:
        db.execute(text(f"UPDATE {S}.patient SET his_patient_id = :m, updated_at = now() WHERE id = :id"), {"m": surviving_mrn, "id": retired["id"]})
        svc.audit(db, svc.SYSTEM_ACTOR_ID, SYSTEM_ROLE, "patient.merged", "patient", str(retired["id"]), {"mrn": retired_mrn},
                  {"mrn": surviving_mrn, "mode": "renumbered"}, "PATIENT_MERGED", cid)
        return "PROCESSED", "Patient renumbered to surviving MRN"
    active = svc._row(db, f"""SELECT (SELECT count(*) FROM {S}.encounter WHERE patient_id = :r AND status = 'ADMITTED') AS r,
                                     (SELECT count(*) FROM {S}.encounter WHERE patient_id = :s AND status = 'ADMITTED') AS s""",
                      r=str(retired["id"]), s=str(surviving["id"]))
    if active["r"] and active["s"]:
        # Two simultaneously admitted records for one person need Health Information Management review.
        _quarantine(db, msg, "MERGE_BOTH_ADMITTED")
        return "QUARANTINED", "Both records have active admissions; queued for HIM review"
    db.execute(text(f"UPDATE {S}.encounter SET patient_id = :s, version = version + 1, updated_at = now() WHERE patient_id = :r"),
               {"s": str(surviving["id"]), "r": str(retired["id"])})
    svc.audit(db, svc.SYSTEM_ACTOR_ID, SYSTEM_ROLE, "patient.merged", "patient", str(surviving["id"]), {"retired_mrn": retired_mrn},
              {"surviving_mrn": surviving_mrn, "mode": "encounters_repointed"}, "PATIENT_MERGED", cid)
    return "PROCESSED", "Encounters moved to surviving patient"


def _swap_beds(db: Session, msg: HL7Message, cid: str) -> tuple[str, str]:
    """A17 carries two PID/PV1 pairs: the two patients exchange beds atomically; both beds stay OCCUPIED."""
    if len(msg.segments.get("PV1", [])) < 2:
        raise DomainError("SWAP_INCOMPLETE", "A17 requires two PV1 segments", 422)
    first, second = _encounter(db, msg, 0), _encounter(db, msg, 1)
    if not first or not second:
        raise DomainError("UNKNOWN_ENCOUNTER", "A17 references an encounter DischargeLoop does not know", 422)
    (ward_a, bed_a), (ward_b, bed_b) = (str(first["ward_id"]), first["bed_id"]), (str(second["ward_id"]), second["bed_id"])
    db.execute(text(f"UPDATE {S}.bed_assignment SET state = 'ENDED', ended_at = now(), updated_at = now()"
                    " WHERE encounter_id IN (:a, :b) AND kind = 'OCCUPANCY' AND state = 'ACTIVE'"), {"a": first["id"], "b": second["id"]})
    for enc, ward, bed in ((first, ward_b, bed_b), (second, ward_a, bed_a)):
        db.execute(text(f"UPDATE {S}.encounter SET ward_id = :w, bed_id = :b, version = version + 1, updated_at = now() WHERE id = :id"),
                   {"w": ward, "b": bed, "id": enc["id"]})
        if bed:
            db.execute(text(f"INSERT INTO {S}.bed_assignment (id, bed_id, encounter_id, kind, state, starts_at) VALUES (:id, :b, :e, 'OCCUPANCY', 'ACTIVE', now())"),
                       {"id": str(uuid.uuid4()), "b": bed, "e": enc["id"]})
        svc.audit(db, svc.SYSTEM_ACTOR_ID, SYSTEM_ROLE, "encounter.swapped", "encounter", str(enc["id"]), None,
                  {"ward_id": ward, "bed_id": bed}, "ENCOUNTER_SWAPPED", cid)
    return "PROCESSED", "Beds swapped"


def _apply_adt(db: Session, msg: HL7Message, event: str, enc: dict | None, hospital_id: str, cid: str) -> tuple[str, str]:
    if event == "ADT_A05":
        _upsert_patient_from(db, hospital_id, msg)
        return "PROCESSED", "Pre-admission noted (encounter created on A01)"
    if event in ("ADT_A01", "ADT_A04", "ADT_A08"):
        patient_id = _upsert_patient_from(db, hospital_id, msg)
        medicare = _is_medicare(msg)
        if event == "ADT_A08" or enc:
            if enc:
                db.execute(text(f"UPDATE {S}.encounter SET medicare = medicare OR :mc, updated_at = now() WHERE id = :id"),
                           {"mc": medicare, "id": enc["id"]})
                svc.schedule_im_initial(db, None, str(enc["id"]), str(enc["ward_id"]), enc["ward_code"], cid)
                svc.audit(db, svc.SYSTEM_ACTOR_ID, SYSTEM_ROLE, "encounter.updated", "encounter", str(enc["id"]), None,
                          {"source": f"HL7_{event[-3:]}"}, "ENCOUNTER_UPDATED", cid)
            return "PROCESSED", "Demographics updated"
        ward_id, bed_id = _resolve_location(db, msg)
        svc.admit(db, None, patient_id, ward_id, bed_id, msg.field("PV1", 19) or msg.control_id, cid, commit=False,
                  patient_class=_patient_class(msg, default="I" if event == "ADT_A01" else "E"), medicare=medicare,
                  event_at=_event_time(msg))
        return "PROCESSED", "Admitted"
    if not enc:
        raise DomainError("UNKNOWN_ENCOUNTER", f"No encounter for visit '{msg.field('PV1', 19)}'", 422)
    if event in ("ADT_A06", "ADT_A07"):
        new_class = _patient_class(msg, default="I" if event == "ADT_A06" else "O")
        db.execute(text(f"UPDATE {S}.encounter SET patient_class = :c, medicare = medicare OR :mc, version = version + 1, updated_at = now()"
                        " WHERE id = :id"), {"c": new_class, "mc": _is_medicare(msg), "id": enc["id"]})
        svc.audit(db, svc.SYSTEM_ACTOR_ID, SYSTEM_ROLE, "encounter.class_changed", "encounter", str(enc["id"]),
                  {"patient_class": enc["patient_class"]}, {"patient_class": new_class}, "ENCOUNTER_CLASS_CHANGED", cid)
        if new_class == "I":
            svc.schedule_im_initial(db, None, str(enc["id"]), str(enc["ward_id"]), enc["ward_code"], cid)
        else:
            # The IM applies to inpatients only (observation patients get the MOON instead): drop open IM tasks.
            db.execute(text(f"UPDATE {S}.task SET status = 'CANCELLED', completed_at = now(), version = version + 1, updated_at = now()"
                            " WHERE encounter_id = :e AND type IN ('IM_INITIAL', 'IM_FOLLOW_UP') AND status IN ('OPEN', 'CLAIMED')"), {"e": enc["id"]})
        return "PROCESSED", f"Patient class changed to {new_class}"
    if event in ("ADT_A21", "ADT_A22"):
        leaving = event == "ADT_A21"
        db.execute(text(f"UPDATE {S}.encounter SET on_leave = :l, version = version + 1, updated_at = now() WHERE id = :id"),
                   {"l": leaving, "id": enc["id"]})
        svc.audit(db, svc.SYSTEM_ACTOR_ID, SYSTEM_ROLE, "encounter.leave", "encounter", str(enc["id"]), None, {"on_leave": leaving},
                  "ENCOUNTER_LEAVE_STARTED" if leaving else "ENCOUNTER_LEAVE_ENDED", cid)
        return "PROCESSED", "Leave of absence started (bed held)" if leaving else "Returned from leave of absence"
    if event == "ADT_A02":
        ward_id, bed_id = _resolve_location(db, msg)
        if enc["bed_id"] and str(enc["bed_id"]) != bed_id:
            _vacate_bed(db, str(enc["bed_id"]), cid)
        if bed_id and str(enc["bed_id"]) != bed_id:
            svc._set_bed_state(db, None, bed_id, "OCCUPIED", "ADMISSION_CONFIRMED", cid)
            db.execute(text(f"INSERT INTO {S}.bed_assignment (id, bed_id, encounter_id, kind, state, starts_at) VALUES (:id, :b, :e, 'OCCUPANCY', 'ACTIVE', now())"),
                       {"id": str(uuid.uuid4()), "b": bed_id, "e": enc["id"]})
        db.execute(text(f"UPDATE {S}.encounter SET ward_id = :w, bed_id = :b, version = version + 1, updated_at = now() WHERE id = :id"),
                   {"w": ward_id, "b": bed_id, "id": enc["id"]})
        svc.audit(db, svc.SYSTEM_ACTOR_ID, SYSTEM_ROLE, "encounter.transferred", "encounter", str(enc["id"]),
                  {"ward_id": enc["ward_id"], "bed_id": enc["bed_id"]}, {"ward_id": ward_id, "bed_id": bed_id}, "ENCOUNTER_TRANSFERRED", cid)
        return "PROCESSED", "Transferred"
    if event == "ADT_A03":
        _ehr_departure(db, enc, cid, _hl7_datetime(msg.field("PV1", 45)))
        return "PROCESSED", "Departed"
    if event == "ADT_A11":
        db.execute(text(f"UPDATE {S}.encounter SET status = 'CANCELLED', version = version + 1, updated_at = now() WHERE id = :id"), {"id": enc["id"]})
        if enc["bed_id"]:
            _vacate_bed(db, str(enc["bed_id"]), cid)
        svc.audit(db, svc.SYSTEM_ACTOR_ID, SYSTEM_ROLE, "encounter.cancelled", "encounter", str(enc["id"]), None, {"source": "HL7_A11"}, "ENCOUNTER_CANCELLED", cid)
        return "PROCESSED", "Admission cancelled"
    if event in ("ADT_A12", "ADT_A13"):
        # Reversing a transfer/discharge may collide with a bed already reassigned: a human must reconcile.
        _quarantine(db, msg, f"{event}_NEEDS_REVIEW")
        return "QUARANTINED", "Queued for manual reconciliation"
    if event == "ADT_A16":
        result = svc.initiate_discharge(db, SYSTEM_ACTOR, str(enc["id"]), cid, _hl7_datetime(msg.field("PV2", 9)), source="HL7_A16")
        return "PROCESSED", "Pending discharge started" if result.get("created") or result.get("restarted") else "Discharge already active"
    if event == "ADT_A25":
        d = svc._row(db, f"SELECT id, state::text AS state, source FROM {S}.discharge WHERE encounter_id = :e", e=enc["id"])
        if d and d["state"] in ACTIVE_DISCHARGE_STATES and d["source"] == "HL7_A16" and d["state"] != "READY_TO_DEPART":
            svc.transition_discharge(db, SYSTEM_ACTOR, str(d["id"]), "CANCELLED", cid, reason="EHR cancelled pending discharge (A25)", commit=False)
            return "PROCESSED", "Pending discharge cancelled"
        return "PROCESSED", "No HL7-initiated discharge to cancel"
    raise HL7Error(f"Unsupported event {event}")


def ingest(db: Session, raw: str) -> tuple[int, str]:
    """Returns (http_status, ack_text). Duplicates (same MSH-10) are acknowledged without re-processing."""
    try:
        msg = parse(raw)
    except HL7Error as exc:
        return 400, ack(None, "AR", str(exc))
    event = _event_type(msg)
    if event not in SUPPORTED:
        return 200, ack(msg, "AR", f"Unsupported message type {msg.message_type}^{msg.trigger}")
    cid = f"hl7-{msg.source_system}-{msg.control_id or uuid.uuid4()}"
    log_id = str(uuid.uuid4())
    tz_row = svc._row(db, f"SELECT timezone FROM {S}.hospital ORDER BY is_primary DESC LIMIT 1")
    try:
        _SENDER_TZ.set(ZoneInfo(os.environ.get("HL7_TIMEZONE") or (tz_row["timezone"] if tz_row else "UTC")))
    except ZoneInfoNotFoundError:
        _SENDER_TZ.set(timezone.utc)
    try:
        db.execute(text(f"INSERT INTO {S}.hl7_event_log (id, source_system, event_type, message_control_id, raw_payload)"
                        f" VALUES (:id, :src, CAST(:e AS {S}.hl7_event_type), :mcid, CAST(:raw AS jsonb))"),
                   {"id": log_id, "src": msg.source_system, "e": event, "mcid": msg.control_id or None, "raw": json.dumps({"raw": raw})})
        db.commit()
    except IntegrityError:
        db.rollback()
        return 200, ack(msg, "AA", "Duplicate message; already processed")
    try:
        status, note = _process(db, msg, event, cid)
        db.execute(text(f"UPDATE {S}.hl7_event_log SET processing_status = :s, processed_at = now(), ack_code = 'AA', error_message = :n WHERE id = :id"),
                   {"s": status, "n": note, "id": log_id})
        db.commit()
        return 200, ack(msg, "AA", note)
    except (DomainError, HL7Error) as exc:
        db.rollback()
        reason = getattr(exc, "code", "HL7_ERROR")
        _quarantine(db, msg, reason)
        db.execute(text(f"UPDATE {S}.hl7_event_log SET processing_status = 'QUARANTINED', processed_at = now(), ack_code = 'AE', error_message = :m WHERE id = :id"),
                   {"m": str(getattr(exc, "message", exc))[:500], "id": log_id})
        db.commit()
        return 200, ack(msg, "AE", str(getattr(exc, "message", exc)))


def feed_health(db: Session) -> dict[str, Any]:
    """Is the EHR feed alive? A silent feed (VPN flap, interface-engine or Epic downtime) is the most common real failure.

    Only judged once a feed has ever delivered (or HL7_FEED_EXPECTED=true), so manual-only sites are not alarmed.
    """
    row = svc._row(db, f"SELECT max(created_at) AS last_at, extract(epoch FROM now() - max(created_at)) AS age FROM {S}.hl7_event_log")
    stale_after = int(os.environ.get("HL7_STALE_MINUTES", "30")) * 60
    expected = os.environ.get("HL7_FEED_EXPECTED", "false").lower() == "true"
    age = float(row["age"]) if row and row["age"] is not None else None
    configured = expected or age is not None
    return {"configured": configured, "last_message_at": row["last_at"] if row else None,
            "age_seconds": round(age) if age is not None else None, "stale_after_seconds": stale_after,
            "stale": bool(configured and (age is None or age > stale_after))}


def integration_status(db: Session) -> dict[str, Any]:
    return {
        "feed": feed_health(db),
        "events": svc._rows(db, f"SELECT event_type::text AS event_type, processing_status, count(*) AS n, max(created_at) AS last_seen"
                                f" FROM {S}.hl7_event_log WHERE created_at > now() - interval '24 hours' GROUP BY 1, 2 ORDER BY 1"),
        "open_quarantine": svc._row(db, f"SELECT count(*) AS n FROM {S}.integration_quarantine WHERE resolved_at IS NULL")["n"],
    }
