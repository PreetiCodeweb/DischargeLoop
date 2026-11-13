"""Real-world Epic ADT feed behaviors against a migrated PostgreSQL (see test_discharge_integration.py for setup)."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.discharge import hl7, service as svc
from app.discharge.domain import Actor, DomainError

DB_URL = os.environ.get("DL_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="DL_TEST_DATABASE_URL not set")
WARD_ID, WARD_CODE = str(uuid.uuid4()), f"R{uuid.uuid4().hex[:6].upper()}"
CID = "test-real-world"


def actor(role: str) -> Actor:
    return Actor(user_id=str(uuid.uuid4()), role=role, email=f"{role}@t", full_name=role, ward_ids=frozenset({WARD_ID}))


DOCTOR, NURSE, CM = actor("doctor"), actor("nurse"), actor("case_manager")


@pytest.fixture(scope="module")
def factory():
    engine = create_engine(DB_URL, connect_args={"options": "-c search_path=medsync,dischargeloop,public"})
    f = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with f() as s:
        s.execute(text("INSERT INTO dischargeloop.ward (id, hospital_id, name, code, department_type) SELECT :id, id, 'RW ward', :c, 'WARD'"
                       " FROM dischargeloop.hospital ORDER BY is_primary DESC LIMIT 1"), {"id": WARD_ID, "c": WARD_CODE})
        s.execute(text("INSERT INTO dischargeloop.bed (id, ward_id, label, state, state_reason_code) SELECT gen_random_uuid(), :w,"
                       " 'B' || lpad(n::text, 2, '0'), 'AVAILABLE', 'CREATED' FROM generate_series(1, 20) n"), {"w": WARD_ID})
        s.commit()
    yield f
    engine.dispose()


@pytest.fixture
def db(factory):
    s = factory()
    yield s
    s.close()


def msg(trigger: str, visit: str, mrn: str, *, bed: str = "", evn: str = "20261112090000", pclass: str = "I",
        name: str = "Test^Patient", extra: str = "", pv1_extra: str = "") -> str:
    msg_type = trigger if "^" in trigger else f"ADT^{trigger}"
    return (f"MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|{evn}||{msg_type}|{uuid.uuid4().hex[:18]}|P|2.5.1\r"
            f"EVN|{trigger[-3:]}|{evn}\rPID|1||{mrn}^^^NSGH^MR||{name}||19480214|F\r"
            f"PV1|1|{pclass}|{WARD_CODE}^^{bed}" + "|" * 16 + f"{visit}\r{pv1_extra}{extra}")


MEDICARE_IN1 = "IN1|1|MCR|00001|MEDICARE PART A||||||||||||MC\r"


def free_bed(db) -> str:
    return db.execute(text("SELECT label FROM dischargeloop.bed WHERE ward_id = :w AND state = 'AVAILABLE' ORDER BY label LIMIT 1"),
                      {"w": WARD_ID}).scalar_one()


def ok(db, raw: str) -> str:
    status, ack = hl7.ingest(db, raw)
    assert status == 200 and "MSA|AA|" in ack, ack
    return ack


def encounter(db, visit: str):
    return db.execute(text("SELECT e.id, e.bed_id, e.status::text AS status, e.patient_class, e.medicare, e.on_leave, p.his_patient_id, p.display_name"
                           " FROM dischargeloop.encounter e JOIN dischargeloop.patient p ON p.id = e.patient_id WHERE his_encounter_id = :v"),
                      {"v": visit}).mappings().one()


def tasks(db, encounter_id, types=("IM_INITIAL", "IM_FOLLOW_UP")):
    return db.execute(text("SELECT type, status::text AS status, blocking, owner_role, due_at FROM dischargeloop.task"
                           " WHERE encounter_id = :e AND type = ANY(CAST(:t AS text[])) ORDER BY created_at"),
                      {"e": encounter_id, "t": list(types)}).mappings().all()


def ids() -> tuple[str, str]:
    return f"V{uuid.uuid4().hex[:10]}", f"M{uuid.uuid4().hex[:10]}"


def test_medicare_inpatient_gets_initial_and_follow_up_important_message(db):
    visit, mrn = ids()
    ok(db, msg("A01", visit, mrn, bed=free_bed(db), extra=MEDICARE_IN1))
    enc = encounter(db, visit)
    assert enc["medicare"] and enc["patient_class"] == "I"
    initial = tasks(db, enc["id"])
    assert [(t["type"], t["status"], t["blocking"], t["owner_role"]) for t in initial] == [("IM_INITIAL", "OPEN", True, "case_manager")]

    ok(db, msg("A16", visit, mrn, evn="20261112100000", extra="PV2|||||||||20261114120000\r"))
    did = db.execute(text("SELECT id FROM dischargeloop.discharge WHERE encounter_id = :e"), {"e": enc["id"]}).scalar_one()
    svc.transition_discharge(db, DOCTOR, str(did), "MEDICALLY_CLEARED", CID)
    svc.transition_discharge(db, NURSE, str(did), "TASKS_PENDING", CID)
    follow = [t for t in tasks(db, enc["id"]) if t["type"] == "IM_FOLLOW_UP"]
    assert len(follow) == 1 and follow[0]["blocking"]  # initial IM not yet delivered: follow-up copy required before discharge

    others = db.execute(text("SELECT id, owner_role FROM dischargeloop.task WHERE encounter_id = :e AND type NOT IN ('IM_INITIAL', 'IM_FOLLOW_UP')"
                             " AND status IN ('OPEN', 'CLAIMED')"), {"e": enc["id"]}).all()
    by_role = {"doctor": DOCTOR, "nurse": NURSE, "case_manager": CM, "pharmacist": actor("pharmacist")}
    for task_id, role in others:
        svc.act_on_task(db, by_role[role], str(task_id), "complete", CID)
    with pytest.raises(DomainError) as blocked:
        svc.transition_discharge(db, NURSE, str(did), "READY_TO_DEPART", CID)  # the IM tasks still block discharge
    assert blocked.value.code == "DISCHARGE_BLOCKED"
    db.rollback()


def test_non_medicare_patient_gets_no_im_tasks(db):
    visit, mrn = ids()
    ok(db, msg("A01", visit, mrn, bed=free_bed(db), extra="IN1|1|BCBS|00002|BLUE CROSS\r"))
    assert tasks(db, encounter(db, visit)["id"]) == []


def test_observation_to_inpatient_and_back_controls_im(db):
    visit, mrn = ids()
    ok(db, msg("A04", visit, mrn, bed=free_bed(db), pclass="O", extra=MEDICARE_IN1))
    enc = encounter(db, visit)
    assert enc["patient_class"] == "O" and tasks(db, enc["id"]) == []      # observation: no IM
    ok(db, msg("A06", visit, mrn, evn="20261112110000", pclass="I", extra=MEDICARE_IN1))
    assert [t["status"] for t in tasks(db, enc["id"])] == ["OPEN"]           # now inpatient: IM due within 2 days
    ok(db, msg("A07", visit, mrn, evn="20261112120000", pclass="O"))
    assert [t["status"] for t in tasks(db, enc["id"])] == ["CANCELLED"]      # back to observation: IM no longer applies


def test_late_replayed_event_does_not_move_patient_backwards(db):
    visit, mrn = ids()
    ok(db, msg("A01", visit, mrn, bed=free_bed(db), evn="20261112080000"))
    ok(db, msg("A21", visit, mrn, evn="20261112120000"))
    assert encounter(db, visit)["on_leave"] is True
    ack = ok(db, msg("A22", visit, mrn, evn="20261112110000"))                 # older than the A21 already applied
    assert "Stale event ignored" in ack and encounter(db, visit)["on_leave"] is True
    ok(db, msg("A22", visit, mrn, evn="20261112130000"))
    assert encounter(db, visit)["on_leave"] is False


def test_bed_swap_exchanges_both_patients_atomically(db):
    (v1, m1), (v2, m2) = ids(), ids()
    b1 = free_bed(db); ok(db, msg("A01", v1, m1, bed=b1))
    b2 = free_bed(db); ok(db, msg("A01", v2, m2, bed=b2))
    before = encounter(db, v1)["bed_id"], encounter(db, v2)["bed_id"]
    swap = (f"MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112140000||ADT^A17|{uuid.uuid4().hex[:18]}|P|2.5.1\rEVN|A17|20261112140000\r"
            f"PID|1||{m1}\rPV1|1|I|{WARD_CODE}^^{b2}" + "|" * 16 + f"{v1}\r"
            f"PID|2||{m2}\rPV1|1|I|{WARD_CODE}^^{b1}" + "|" * 16 + f"{v2}\r")
    ok(db, swap)
    assert (encounter(db, v1)["bed_id"], encounter(db, v2)["bed_id"]) == (before[1], before[0])
    occupied = db.execute(text("SELECT count(*) FROM dischargeloop.bed WHERE id IN (:a, :b) AND state = 'OCCUPIED'"),
                          {"a": before[0], "b": before[1]}).scalar_one()
    active = db.execute(text("SELECT count(*) FROM dischargeloop.bed_assignment WHERE bed_id IN (:a, :b) AND state = 'ACTIVE'"),
                        {"a": before[0], "b": before[1]}).scalar_one()
    assert occupied == 2 and active == 2


def test_patient_merge_renumbers_or_quarantines(db):
    visit, old_mrn = ids()
    new_mrn = f"N{uuid.uuid4().hex[:10]}"
    ok(db, msg("A01", visit, old_mrn, bed=free_bed(db)))
    merge = (f"MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112150000||ADT^A40|{uuid.uuid4().hex[:18]}|P|2.5.1\rEVN|A40|20261112150000\r"
             f"PID|1||{new_mrn}\rMRG|{old_mrn}\r")
    assert "renumbered" in ok(db, merge)
    assert encounter(db, visit)["his_patient_id"] == new_mrn

    (va, ma), (vb, mb) = ids(), ids()
    ok(db, msg("A01", va, ma, bed=free_bed(db)))
    ok(db, msg("A01", vb, mb, bed=free_bed(db)))
    both = (f"MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112150000||ADT^A40|{uuid.uuid4().hex[:18]}|P|2.5.1\r"
            f"PID|1||{ma}\rMRG|{mb}\r")
    assert "HIM review" in ok(db, both)  # two active admissions for one person: never auto-merge


def test_newborn_without_name_is_accepted(db):
    visit, mrn = ids()
    ok(db, msg("A01", visit, mrn, bed=free_bed(db), name=""))
    assert encounter(db, visit)["display_name"] == "Unidentified patient"
