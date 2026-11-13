"""Unit tests for DischargeLoop rules that need no database."""
import pytest

from app.discharge import hl7
from app.discharge.domain import (
    DomainError, assert_bed_transition, assert_discharge_transition, functional_role,
)


@pytest.mark.parametrize("source", ["MEDICALLY_CLEARED", "TASKS_PENDING", "READY_TO_DEPART"])
def test_clinical_reversal_is_reachable(source):
    # Defect #1 regression: the teammate's matrix made CANCELLED_REVERSED unreachable.
    assert_discharge_transition(source, "CANCELLED_REVERSED")


@pytest.mark.parametrize("source", ["CANCELLED", "CANCELLED_REVERSED"])
def test_cancelled_or_reversed_discharge_can_restart(source):
    assert_discharge_transition(source, "INITIATED")


@pytest.mark.parametrize("source,target", [
    ("INITIATED", "READY_TO_DEPART"),      # cannot skip medical clearance
    ("INITIATED", "CANCELLED_REVERSED"),   # nothing to reverse before clearance
    ("DEPARTED", "INITIATED"),             # departure is terminal
    ("READY_TO_DEPART", "CANCELLED"),      # a ready patient who must stay is a reversal, with a reason
])
def test_illegal_discharge_transitions(source, target):
    with pytest.raises(DomainError) as exc:
        assert_discharge_transition(source, target)
    assert exc.value.code == "ILLEGAL_DISCHARGE_TRANSITION"


def test_cleaning_bed_cannot_skip_to_reserved():
    with pytest.raises(DomainError):
        assert_bed_transition("CLEANING", "RESERVED")
    assert_bed_transition("CLEANING", "AVAILABLE")


def test_functional_role_is_ward_scoped():
    assert functional_role("pharmacist", "4A") == "pharmacist@4A"


RAW_A01 = (
    "MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112093000||ADT^A01|MSG0001|P|2.5.1\r"
    "EVN|A01|20261112093000\r"
    "PID|1||MRN123456^^^NSGH^MR||Doe^Jane||19500101|F\r"
    "PV1|1|I|4A^^4A-07" + "|" * 16 + "V12345678\r"  # PV1-19 visit number
)


def test_hl7_parser_reads_epic_adt_fields():
    msg = hl7.parse(RAW_A01)
    assert (msg.message_type, msg.trigger, msg.control_id, msg.source_system) == ("ADT", "A01", "MSG0001", "EPIC")
    assert msg.field("PID", 3) == "MRN123456"
    assert (msg.field("PID", 5, 1), msg.field("PID", 5, 2)) == ("Doe", "Jane")
    assert (msg.field("PV1", 3, 1), msg.field("PV1", 3, 3), msg.field("PV1", 19)) == ("4A", "4A-07", "V12345678")


def test_hl7_parser_accepts_lf_and_mllp_framing():
    msg = hl7.parse("\x0b" + RAW_A01.replace("\r", "\n") + "\x1c")
    assert msg.control_id == "MSG0001"


def test_hl7_rejects_non_hl7_payload():
    with pytest.raises(hl7.HL7Error):
        hl7.parse("hello world")


def test_hl7_timestamps_use_sender_local_time_unless_offset_given():
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo
    token = hl7._SENDER_TZ.set(ZoneInfo("America/New_York"))
    try:
        # 14:00 Eastern (EST, Nov) is 19:00 UTC; an explicit offset always wins.
        assert hl7._hl7_datetime("20261113140000") == datetime(2026, 11, 13, 19, 0, tzinfo=timezone.utc)
        assert hl7._hl7_datetime("20261113140000-0800") == datetime(2026, 11, 13, 22, 0, tzinfo=timezone.utc)
        assert hl7._hl7_datetime("20260701140000") == datetime(2026, 7, 1, 18, 0, tzinfo=timezone.utc)  # EDT in summer
        assert hl7._hl7_datetime("garbage") is None
    finally:
        hl7._SENDER_TZ.reset(token)


def test_ack_echoes_control_id_and_escapes_separators():
    ack = hl7.ack(hl7.parse(RAW_A01), "AE", "bad|location")
    assert "MSA|AE|MSG0001|bad/location" in ack
    assert ack.startswith("MSH|^~\\&|DISCHARGELOOP")
