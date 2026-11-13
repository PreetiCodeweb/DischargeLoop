"""End-to-end DischargeLoop flow against a real, migrated PostgreSQL (schema + demo seed).

Set DL_TEST_DATABASE_URL to the *app* role connection string (least privilege, exactly like production).
Each test uses fresh visit numbers / control ids, so tests are order-independent and re-runnable.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.discharge import escalation, hl7, service as svc
from app.discharge.domain import Actor, DomainError

DB_URL = os.environ.get("DL_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="DL_TEST_DATABASE_URL not set")
# Every run gets its own ward + beds so tests never compete with demo data or previous runs for capacity.
WARD_ID = str(uuid.uuid4())
WARD_CODE = f"T{uuid.uuid4().hex[:6].upper()}"
WARD_4A = WARD_ID


@pytest.fixture(scope="module")
def session_factory():
    engine = create_engine(DB_URL, connect_args={"options": "-c search_path=medsync,dischargeloop,public"})
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with factory() as s:
        s.execute(text("INSERT INTO dischargeloop.ward (id, hospital_id, name, code, department_type)"
                       " SELECT :id, id, 'Test ward', :code, 'WARD' FROM dischargeloop.hospital ORDER BY is_primary DESC LIMIT 1"),
                  {"id": WARD_ID, "code": WARD_CODE})
        s.execute(text("INSERT INTO dischargeloop.bed (id, ward_id, label, state, state_reason_code)"
                       " SELECT gen_random_uuid(), :w, 'B' || lpad(n::text, 2, '0'), 'AVAILABLE', 'CREATED' FROM generate_series(1, 12) n"),
                  {"w": WARD_ID})
        s.commit()
    yield factory
    engine.dispose()


@pytest.fixture
def db(session_factory):
    s = session_factory()
    yield s
    s.close()


def actor(role: str, user_id: str | None = None, wards=frozenset({WARD_4A})) -> Actor:
    return Actor(user_id=user_id or str(uuid.uuid4()), role=role, email=f"{role}@test", full_name=role, ward_ids=wards)


DOCTOR, NURSE, CM, PHARM = actor("doctor"), actor("nurse"), actor("case_manager"), actor("pharmacist")
EVS1, EVS2 = actor("housekeeping"), actor("housekeeping")
CID = "test-correlation"


def free_bed(db) -> str:
    return db.execute(text("SELECT label FROM dischargeloop.bed WHERE ward_id = :w AND state = 'AVAILABLE' ORDER BY label LIMIT 1"),
                      {"w": WARD_4A}).scalar_one()


def adt(trigger: str, visit: str, bed_label: str = "", extra: str = "", control: str | None = None) -> str:
    return (f"MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112093000||ADT^{trigger}|{control or uuid.uuid4().hex[:16]}|P|2.5.1\r"
            f"EVN|{trigger}|20261112093000\r"
            f"PID|1||MRN-{visit}^^^NSGH^MR||Test^Patient||19500101|F\r"
            f"{pv1(f'{WARD_CODE}^^{bed_label}', visit)}{extra}")


def pv1(location: str, visit: str) -> str:
    return f"PV1|1|I|{location}" + "|" * 16 + f"{visit}\r"  # PV1-3 location, PV1-19 visit number


def admit_via_hl7(db) -> tuple[str, str, str]:
    visit, bed_label = f"T{uuid.uuid4().hex[:10]}", free_bed(db)
    status, ack = hl7.ingest(db, adt("A01", visit, bed_label))
    assert status == 200 and "MSA|AA|" in ack, ack
    enc = db.execute(text("SELECT id, bed_id FROM dischargeloop.encounter WHERE his_encounter_id = :v"), {"v": visit}).one()
    return visit, str(enc.id), str(enc.bed_id)


def bed_state(db, bed_id: str) -> str:
    return db.execute(text("SELECT state::text FROM dischargeloop.bed WHERE id = :b"), {"b": bed_id}).scalar_one()


def test_full_discharge_loop_with_reversal_blockers_hl7_and_cleaning(db):
    visit, encounter_id, bed_id = admit_via_hl7(db)
    assert bed_state(db, bed_id) == "OCCUPIED"

    # A16 pending discharge starts the workflow automatically (zero re-entry for staff).
    status, ack = hl7.ingest(db, adt("A16", visit, extra="PV2|||||||||20261113120000\r"))
    assert "MSA|AA|" in ack
    d = db.execute(text("SELECT id, source, expected_discharge_at FROM dischargeloop.discharge WHERE encounter_id = :e"), {"e": encounter_id}).one()
    discharge_id = str(d.id)
    assert d.source == "HL7_A16" and d.expected_discharge_at is not None

    with pytest.raises(DomainError) as forbidden:
        svc.transition_discharge(db, NURSE, discharge_id, "MEDICALLY_CLEARED", CID)
    assert forbidden.value.status == 403  # only physicians clear medically
    db.rollback()
    svc.transition_discharge(db, DOCTOR, discharge_id, "MEDICALLY_CLEARED", CID)
    svc.transition_discharge(db, NURSE, discharge_id, "TASKS_PENDING", CID)

    detail = svc.get_discharge(db, CM, discharge_id, CID, "127.0.0.1")
    owners = {t["owner"] for t in detail["tasks"]}
    assert {f"{r}@{WARD_CODE}" for r in ("pharmacist", "doctor", "nurse", "case_manager")} <= owners  # feature 2: named, ward-scoped

    blocker = svc.open_blocker(db, CM, discharge_id, "POST_ACUTE_PLACEMENT", "Awaiting SNF acceptance", CID,
                               external_party="Maple Grove SNF")
    assert blocker["side"] == "EXTERNAL"
    with pytest.raises(DomainError) as external_party_missing:
        svc.open_blocker(db, CM, discharge_id, "TRANSPORT", "Wheelchair van", CID)
    assert external_party_missing.value.code == "EXTERNAL_PARTY_REQUIRED"
    db.rollback()

    # READY gate: open blockers/tasks prevent READY_TO_DEPART.
    with pytest.raises(DomainError) as gate:
        svc.transition_discharge(db, NURSE, discharge_id, "READY_TO_DEPART", CID)
    assert gate.value.code == "DISCHARGE_BLOCKED"
    db.rollback()

    # Feature 5 passive auto-completion: pharmacy dispense (RDE) closes the meds task without a click.
    rde = (f"MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112100000||RDE^O11|{uuid.uuid4().hex[:16]}|P|2.5.1\r"
           f"PID|1||MRN-{visit}\r{pv1(f'{WARD_CODE}^^', visit)}RXE||APIXABAN5^Apixaban 5 mg\r")
    _, ack = hl7.ingest(db, rde)
    assert "Auto-completed 1 task" in ack
    meds = db.execute(text("SELECT status::text FROM dischargeloop.task WHERE discharge_id = :d AND type = 'MEDS_RECONCILIATION'"),
                      {"d": discharge_id}).scalar_one()
    assert meds == "DONE"

    svc.close_blocker(db, CM, blocker["id"], "resolve", "SNF accepted, bed at 14:00", CID)
    open_tasks = [t for t in svc.get_discharge(db, CM, discharge_id, CID, None)["tasks"] if t["status"] in ("OPEN", "CLAIMED")]
    summary = next(t for t in open_tasks if t["owner_role"] == "doctor")
    with pytest.raises(DomainError) as not_owner:
        svc.act_on_task(db, CM, str(summary["id"]), "complete", CID)  # a coordinator cannot sign for the physician
    assert not_owner.value.status == 403
    db.rollback()
    by_role = {"doctor": DOCTOR, "nurse": NURSE, "case_manager": CM, "pharmacist": PHARM}
    for task in open_tasks:
        svc.act_on_task(db, by_role[task["owner_role"]], str(task["id"]), "complete", CID)
    svc.transition_discharge(db, NURSE, discharge_id, "READY_TO_DEPART", CID)

    # The "2 PM fever": reversal must work (defect #1), keep the bed OCCUPIED and store the reason (defect #2).
    with pytest.raises(DomainError) as no_reason:
        svc.transition_discharge(db, DOCTOR, discharge_id, "CANCELLED_REVERSED", CID)
    assert no_reason.value.code == "REASON_REQUIRED"
    db.rollback()
    svc.transition_discharge(db, DOCTOR, discharge_id, "CANCELLED_REVERSED", CID, reason="Temp 39.2C at 14:05, sepsis workup")
    row = db.execute(text("SELECT state::text, reversal_reason, reversal_count FROM dischargeloop.discharge WHERE id = :d"),
                     {"d": discharge_id}).one()
    assert row == ("CANCELLED_REVERSED", "Temp 39.2C at 14:05, sepsis workup", 1)
    assert bed_state(db, bed_id) == "OCCUPIED"
    alerts = db.execute(text("SELECT count(*) FROM dischargeloop.notification WHERE entity_id = :d AND kind = 'DISCHARGE_REVERSED'"
                             " AND severity = 'CRITICAL'"), {"d": discharge_id}).scalar_one()
    assert alerts == 4
    reasons = db.execute(text("SELECT reason_code::text FROM dischargeloop.audit_event WHERE entity_id = :d ORDER BY occurred_at"),
                         {"d": discharge_id}).scalars().all()
    assert {"DISCHARGE_MEDICALLY_CLEARED", "DISCHARGE_TASKS_PENDING", "DISCHARGE_READY_TO_DEPART", "DISCHARGE_CANCELLED_REVERSED"} <= set(reasons)

    # Restart once the patient recovers, then the EHR's A03 is authoritative for departure.
    restarted = svc.initiate_discharge(db, NURSE, encounter_id, CID)
    assert restarted.get("restarted") is True
    # Work done before the fever is stale (new meds are likely): the checklist must be regenerated.
    svc.transition_discharge(db, DOCTOR, discharge_id, "MEDICALLY_CLEARED", CID)
    svc.transition_discharge(db, NURSE, discharge_id, "TASKS_PENDING", CID)
    redo = db.execute(text("SELECT count(*) FROM dischargeloop.task WHERE discharge_id = :d AND type = 'MEDS_RECONCILIATION'"
                           " AND status = 'OPEN'"), {"d": discharge_id}).scalar_one()
    assert redo == 1
    _, ack = hl7.ingest(db, adt("A03", visit))
    assert "MSA|AA|" in ack
    assert bed_state(db, bed_id) == "CLEANING"

    # Human-confirmed turnaround: two different people must accept and verify the cleaning.
    cleaning_id = db.execute(text("SELECT id FROM dischargeloop.cleaning WHERE bed_id = :b AND status <> 'VERIFIED'"), {"b": bed_id}).scalar_one()
    svc.act_on_cleaning(db, EVS1, str(cleaning_id), "accept", CID)
    with pytest.raises(DomainError) as same_person:
        svc.act_on_cleaning(db, EVS1, str(cleaning_id), "verify", CID)
    assert same_person.value.code == "SECOND_PERSON_REQUIRED"
    db.rollback()
    svc.act_on_cleaning(db, EVS2, str(cleaning_id), "verify", CID)
    assert bed_state(db, bed_id) == "AVAILABLE"


def test_hl7_duplicate_message_is_idempotent(db):
    visit, bed_label, control = f"T{uuid.uuid4().hex[:10]}", free_bed(db), uuid.uuid4().hex[:16]
    first = hl7.ingest(db, adt("A01", visit, bed_label, control=control))
    second = hl7.ingest(db, adt("A01", visit, bed_label, control=control))
    assert "MSA|AA|" in first[1] and "Duplicate" in second[1]
    count = db.execute(text("SELECT count(*) FROM dischargeloop.encounter WHERE his_encounter_id = :v"), {"v": visit}).scalar_one()
    assert count == 1


def test_hl7_unknown_location_is_quarantined_with_ae(db):
    msg = adt("A01", f"T{uuid.uuid4().hex[:10]}").replace(f"PV1|1|I|{WARD_CODE}^^", "PV1|1|I|NOWARD^^")
    status, ack = hl7.ingest(db, msg)
    assert status == 200 and "MSA|AE|" in ack and "NOWARD" in ack


def test_overdue_task_escalates_once_per_level(db):
    visit, encounter_id, _ = admit_via_hl7(db)
    discharge_id = svc.initiate_discharge(db, NURSE, encounter_id, CID)["id"]
    svc.transition_discharge(db, DOCTOR, discharge_id, "MEDICALLY_CLEARED", CID)
    svc.transition_discharge(db, NURSE, discharge_id, "TASKS_PENDING", CID)
    task_id = db.execute(text("SELECT id FROM dischargeloop.task WHERE discharge_id = :d AND type = 'TRANSPORT'"), {"d": discharge_id}).scalar_one()
    db.execute(text("UPDATE dischargeloop.task SET due_at = now() - interval '90 minutes' WHERE id = :t"), {"t": task_id})
    db.commit()
    now = datetime.now(timezone.utc)
    escalation.run_escalations(db, now)
    escalation.run_escalations(db, now + timedelta(seconds=5))  # re-run must not duplicate notifications
    level = db.execute(text("SELECT escalation_level FROM dischargeloop.task WHERE id = :t"), {"t": task_id}).scalar_one()
    sent = db.execute(text("SELECT recipient_role FROM dischargeloop.notification WHERE entity_id = :t ORDER BY recipient_role"),
                      {"t": task_id}).scalars().all()
    assert level == 2 and sent == ["case_manager", "case_manager"]  # L1 owner (case_manager) + L2 case_manager


def test_ward_scope_limits_worklist_and_logs_phi_access(db):
    outsider = actor("nurse", wards=frozenset())
    result = svc.worklist(db, outsider, None, CID, "127.0.0.1")
    assert result["items"] == []
    with pytest.raises(DomainError) as denied:
        svc.worklist(db, outsider, WARD_4A, CID, None)
    assert denied.value.status == 403
    db.rollback()
    insider = actor("nurse", user_id=str(uuid.uuid4()))
    assert svc.worklist(db, insider, WARD_4A, CID, "127.0.0.1")["items"]
    logged = db.execute(text("SELECT count(*) FROM dischargeloop.phi_access_log WHERE actor_id = :a AND action = 'VIEW_WORKLIST'"),
                        {"a": insider.user_id}).scalar_one()
    assert logged == 1
