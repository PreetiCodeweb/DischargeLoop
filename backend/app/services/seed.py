import logging
import os

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import hash_password
from app.models.models import User, UserRole

logger = logging.getLogger(__name__)

# Synthetic DischargeLoop staff for the local demo (ward 4A). Two housekeepers so the two-person
# cleaning verification can be exercised. Created only when DEMO_USER_PASSWORD is set.
DEMO_STAFF = (
    ("doctor.4a@northstar.example", "Dr. Avery Chen", UserRole.DOCTOR),
    ("nurse.4a@northstar.example", "Riley Brooks RN", UserRole.NURSE),
    ("cm.4a@northstar.example", "Sam Ortiz (Case Mgmt)", UserRole.CASE_MANAGER),
    ("pharm.4a@northstar.example", "Pat Nguyen PharmD", UserRole.PHARMACIST),
    ("evs1.4a@northstar.example", "Alex Kim (EVS)", UserRole.HOUSEKEEPING),
    ("evs2.4a@northstar.example", "Jamie Fox (EVS)", UserRole.HOUSEKEEPING),
    ("transport.4a@northstar.example", "Drew Hall (Transport)", UserRole.TRANSPORT),
    ("beds@northstar.example", "Taylor Reed (Bed Mgmt)", UserRole.BED_MANAGER),
)
DEMO_WARD_CODES = ("4A", "5B")


def _ensure_user(db: Session, email: str, full_name: str, role: str, password: str) -> User:
    user = db.query(User).filter(User.email == email).first()
    if user:
        return user
    password_hash = hash_password(password)
    user = User(email=email, full_name=full_name, role=role, password_hash=password_hash,
                hashed_password=password_hash, is_active=True, is_verified=True)
    db.add(user)
    db.flush()
    return user


def seed_demo(db: Session) -> None:
    """Idempotently provision the configured local administrator and optional demo staff.

    Passwords are deliberately required through ADMIN_PASSWORD / DEMO_USER_PASSWORD so a credential
    can never be committed to the repository or baked into an image.
    """
    settings = get_settings()
    if settings.ADMIN_PASSWORD:
        _ensure_user(db, settings.ADMIN_EMAIL, settings.ADMIN_USERNAME, UserRole.HOSPITAL_ADMIN.value, settings.ADMIN_PASSWORD)
    demo_password = os.environ.get("DEMO_USER_PASSWORD", "")
    if demo_password:
        wards = db.execute(text("SELECT id FROM dischargeloop.ward WHERE code = ANY(CAST(:codes AS text[]))"),
                           {"codes": list(DEMO_WARD_CODES)}).scalars().all()
        for email, name, role in DEMO_STAFF:
            user = _ensure_user(db, email, name, role.value, demo_password)
            for ward_id in wards:
                db.execute(text("INSERT INTO dischargeloop.user_ward_scope (user_id, ward_id) VALUES (:u, :w) ON CONFLICT DO NOTHING"),
                           {"u": str(user.id), "w": str(ward_id)})
        logger.info("Demo staff ensured: %d users, %d wards", len(DEMO_STAFF), len(wards))
    db.commit()
