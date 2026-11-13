"""Pure DischargeLoop domain rules: state machines, roles, blocker defaults. No I/O."""
from __future__ import annotations

from dataclasses import dataclass


class DomainError(Exception):
    def __init__(self, code: str, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# ---------------------------------------------------------------- discharge lifecycle
ACTIVE_DISCHARGE_STATES = ("INITIATED", "MEDICALLY_CLEARED", "TASKS_PENDING", "READY_TO_DEPART")
DISCHARGE_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "INITIATED": ("MEDICALLY_CLEARED", "CANCELLED"),
    "MEDICALLY_CLEARED": ("TASKS_PENDING", "CANCELLED", "CANCELLED_REVERSED"),
    "TASKS_PENDING": ("READY_TO_DEPART", "CANCELLED", "CANCELLED_REVERSED"),
    # The "2 PM fever": a patient ready to leave deteriorates and must stay.
    "READY_TO_DEPART": ("DEPARTED", "CANCELLED_REVERSED"),
    "DEPARTED": (),
    # A reversed or cancelled discharge is restarted from the beginning when the patient is ready again.
    "CANCELLED": ("INITIATED",),
    "CANCELLED_REVERSED": ("INITIATED",),
}

DISCHARGE_REASON = {
    "INITIATED": "DISCHARGE_INITIATED",
    "MEDICALLY_CLEARED": "DISCHARGE_MEDICALLY_CLEARED",
    "TASKS_PENDING": "DISCHARGE_TASKS_PENDING",
    "READY_TO_DEPART": "DISCHARGE_READY_TO_DEPART",
    "DEPARTED": "DISCHARGE_DEPARTED",
    "CANCELLED": "DISCHARGE_CANCELLED",
    "CANCELLED_REVERSED": "DISCHARGE_CANCELLED_REVERSED",
}


def assert_discharge_transition(current: str, target: str) -> None:
    if target not in DISCHARGE_TRANSITIONS.get(current, ()):
        raise DomainError("ILLEGAL_DISCHARGE_TRANSITION", f"Discharge cannot move from {current} to {target}")


# ---------------------------------------------------------------- bed lifecycle
BED_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "AVAILABLE": ("RESERVED", "OCCUPIED", "BLOCKED", "MAINTENANCE"),
    "RESERVED": ("AVAILABLE", "OCCUPIED"),
    "OCCUPIED": ("CLEANING", "BLOCKED", "MAINTENANCE"),
    # CLEANING -> AVAILABLE only through the two-person cleaning verification.
    "CLEANING": ("AVAILABLE",),
    "BLOCKED": ("AVAILABLE",),
    "MAINTENANCE": ("AVAILABLE",),
}


def assert_bed_transition(current: str, target: str) -> None:
    if target not in BED_TRANSITIONS.get(current, ()):
        raise DomainError("ILLEGAL_BED_TRANSITION", f"Bed cannot move from {current} to {target}")


# ---------------------------------------------------------------- roles (functional, ward-scoped)
ADMIN_ROLES = frozenset({"system_admin", "hospital_admin"})
HOSPITAL_WIDE_ROLES = ADMIN_ROLES | {"operations_manager", "bed_manager", "admission"}
CLINICAL_ROLES = frozenset({"doctor", "nurse"})
COORDINATOR_ROLES = frozenset({"case_manager", "operations_manager"})
TASK_OWNER_ROLES = frozenset(
    {"doctor", "nurse", "case_manager", "pharmacist", "transport", "housekeeping", "billing", "bed_manager", "admission"}
)

# "system" is the EHR integration actor (HL7 A16 initiates, A25 cancels); it never holds a user session.
SYSTEM_ROLE = "system"
CAN_INITIATE = ADMIN_ROLES | CLINICAL_ROLES | {"case_manager", SYSTEM_ROLE}
CAN_TRANSITION: dict[str, frozenset[str]] = {
    "MEDICALLY_CLEARED": ADMIN_ROLES | {"doctor"},
    "TASKS_PENDING": ADMIN_ROLES | CLINICAL_ROLES | {"case_manager"},
    "READY_TO_DEPART": ADMIN_ROLES | CLINICAL_ROLES | {"case_manager"},
    "DEPARTED": ADMIN_ROLES | {"nurse", "case_manager"},
    "CANCELLED": ADMIN_ROLES | CLINICAL_ROLES | {"case_manager", SYSTEM_ROLE},
    "CANCELLED_REVERSED": ADMIN_ROLES | CLINICAL_ROLES,
    "INITIATED": CAN_INITIATE,
}
CAN_MANAGE_BLOCKERS = ADMIN_ROLES | CLINICAL_ROLES | {"case_manager"}
CAN_MANAGE_ANY_TASK = ADMIN_ROLES | {"case_manager", "nurse"}
CAN_RESERVE = ADMIN_ROLES | {"admission", "bed_manager", "case_manager"}
CAN_CLEAN = ADMIN_ROLES | {"housekeeping", "bed_manager", "nurse"}


def functional_role(role: str, ward_code: str | None) -> str:
    """Tasks are owned by a role on a ward (e.g. pharmacist@4A) so they survive shift changes."""
    return f"{role}@{ward_code}" if ward_code else role


# ---------------------------------------------------------------- blockers (feature 3)
BLOCKER_CATEGORIES = (
    "MEDICATION_RECONCILIATION", "LABS", "PT_OT_CLEARANCE", "DISCHARGE_SUMMARY", "PRIOR_AUTH_INSURANCE",
    "TRANSPORT", "DME_EQUIPMENT", "POST_ACUTE_PLACEMENT", "FAMILY_CAREGIVER", "OTHER",
)
DEFAULT_BLOCKER_SIDE = {
    "MEDICATION_RECONCILIATION": "INTERNAL", "LABS": "INTERNAL", "PT_OT_CLEARANCE": "INTERNAL",
    "DISCHARGE_SUMMARY": "INTERNAL", "PRIOR_AUTH_INSURANCE": "EXTERNAL", "TRANSPORT": "EXTERNAL",
    "DME_EQUIPMENT": "EXTERNAL", "POST_ACUTE_PLACEMENT": "EXTERNAL", "FAMILY_CAREGIVER": "EXTERNAL", "OTHER": "INTERNAL",
}
DEFAULT_BLOCKER_OWNER = {
    "MEDICATION_RECONCILIATION": "pharmacist", "LABS": "doctor", "PT_OT_CLEARANCE": "nurse",
    "DISCHARGE_SUMMARY": "doctor", "PRIOR_AUTH_INSURANCE": "case_manager", "TRANSPORT": "case_manager",
    "DME_EQUIPMENT": "case_manager", "POST_ACUTE_PLACEMENT": "case_manager", "FAMILY_CAREGIVER": "case_manager",
    "OTHER": "nurse",
}


@dataclass(frozen=True)
class TaskTemplate:
    type: str
    title: str
    owner_role: str
    due_minutes: int
    priority: int = 3


# Fan-out when a discharge reaches TASKS_PENDING (US acute-care baseline; hospitals tune these later).
DEFAULT_TASK_TEMPLATES = (
    TaskTemplate("MEDS_RECONCILIATION", "Discharge medication reconciliation", "pharmacist", 120, 2),
    TaskTemplate("DISCHARGE_SUMMARY", "Sign discharge summary and prescriptions", "doctor", 180, 2),
    TaskTemplate("PATIENT_EDUCATION", "Discharge instructions and teach-back", "nurse", 180, 3),
    TaskTemplate("TRANSPORT", "Arrange transport home or to facility", "case_manager", 240, 3),
)


@dataclass(frozen=True)
class Actor:
    user_id: str
    role: str
    email: str
    full_name: str
    ward_ids: frozenset[str] | None  # None = hospital-wide scope

    @property
    def hospital_wide(self) -> bool:
        return self.ward_ids is None

    def can_see_ward(self, ward_id: str) -> bool:
        return self.ward_ids is None or str(ward_id) in self.ward_ids

    def require(self, allowed: frozenset[str], action: str) -> None:
        if self.role not in allowed:
            raise DomainError("FORBIDDEN", f"Role {self.role} may not {action}", 403)
