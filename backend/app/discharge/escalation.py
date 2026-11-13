"""Feature 4: overdue-task escalation. Idempotent: each task notifies at most once per escalation level."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.discharge.service import SCHEMA, SYSTEM_ACTOR_ID, _rows, audit, notify


def check_feed_health(db: Session) -> bool:
    """Raise a CRITICAL ops alert (at most one per hour) when the EHR feed has gone silent. Returns stale flag."""
    from app.discharge.hl7 import feed_health  # local import: hl7 imports service, avoid a cycle at module load

    health = feed_health(db)
    if health["stale"]:
        hour = datetime.now(timezone.utc).strftime("%Y%m%d%H")
        minutes = (health["age_seconds"] or 0) // 60
        for role in ("operations_manager", "hospital_admin"):
            notify(db, role, None, "EHR_FEED_STALE", "CRITICAL", "EHR feed silent — ADT updates may be missing",
                   f"No HL7 message for {minutes} min. Check the VPN / interface engine; verify the census manually until it recovers.",
                   None, None, f"feed-stale:{hour}:{role}")
        db.commit()
    return health["stale"]


def run_escalations(db: Session, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    correlation_id = f"escalation-{uuid.uuid4()}"
    policies = _rows(db, f"SELECT task_type, level, after_minutes, notify_role FROM {SCHEMA}.escalation_policy WHERE is_active ORDER BY level")
    overdue = _rows(db, f"""
        SELECT t.id, t.type, t.title, t.owner_role, t.owner_ward_id, t.due_at, t.escalation_level, w.code AS ward_code, b.label AS bed_label
          FROM {SCHEMA}.task t JOIN {SCHEMA}.encounter e ON e.id = t.encounter_id JOIN {SCHEMA}.ward w ON w.id = e.ward_id
          LEFT JOIN {SCHEMA}.bed b ON b.id = e.bed_id
         WHERE t.status IN ('OPEN', 'CLAIMED') AND t.due_at < :now
         FOR UPDATE OF t SKIP LOCKED""", now=now)
    escalated = 0
    for task in overdue:
        minutes_overdue = (now - task["due_at"]).total_seconds() / 60
        # A policy for the specific task type overrides the '*' default at the same level.
        by_level: dict[int, dict] = {}
        for p in policies:
            if p["task_type"] in (task["type"], "*") and (p["level"] not in by_level or p["task_type"] != "*"):
                by_level[p["level"]] = p
        due_levels = [lvl for lvl, p in sorted(by_level.items()) if lvl > task["escalation_level"] and minutes_overdue >= p["after_minutes"]]
        if not due_levels:
            continue
        for level in due_levels:
            p = by_level[level]
            role = task["owner_role"] if p["notify_role"] == "OWNER" else p["notify_role"]
            ward = str(task["owner_ward_id"]) if p["notify_role"] in ("OWNER", "case_manager", "nurse") else None
            where = f"bed {task['bed_label']} ({task['ward_code']})" if task["bed_label"] else f"ward {task['ward_code']}"
            notify(db, role, ward, "TASK_OVERDUE", "WARNING" if level == 1 else "CRITICAL",
                   f"Overdue L{level}: {task['title']}", f"{int(minutes_overdue)} min overdue for {where}. Owner: {task['owner_role']}@{task['ward_code']}.",
                   "task", str(task["id"]), f"escalation:{task['id']}:{level}")
        top = max(due_levels)
        db.execute(text(f"UPDATE {SCHEMA}.task SET escalation_level = :lvl, last_escalated_at = :now, updated_at = now()"
                        " WHERE id = :id"), {"lvl": top, "now": now, "id": task["id"]})
        audit(db, SYSTEM_ACTOR_ID, "system", "task.escalated", "task", str(task["id"]), {"escalation_level": task["escalation_level"]},
              {"escalation_level": top, "minutes_overdue": int(minutes_overdue)}, "TASK_ESCALATED", correlation_id)
        escalated += 1
    db.commit()
    return escalated
