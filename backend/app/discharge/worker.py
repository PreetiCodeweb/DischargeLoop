"""Background worker: escalates overdue tasks and expires stale bed reservations.

Run as its own container (`python -m app.discharge.worker`). Each cycle is independent and idempotent,
so restarts or multiple replicas are safe (rows are claimed with FOR UPDATE SKIP LOCKED).
"""
from __future__ import annotations

import logging
import os
import random
import signal
import time
import uuid

from sqlalchemy.exc import SQLAlchemyError

from app.database.session import SessionLocal
from app.discharge import escalation, service

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("dischargeloop.worker")
_running = True


def _stop(*_: object) -> None:
    global _running
    _running = False


def run_cycle() -> tuple[int, int]:
    db = SessionLocal()
    try:
        escalated = escalation.run_escalations(db)
        expired = service.expire_reservations(db, f"worker-{uuid.uuid4()}")
        if escalation.check_feed_health(db):
            log.warning("ehr feed stale")
        return escalated, expired
    finally:
        db.close()


def main() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    interval = int(os.environ.get("WORKER_INTERVAL_SECONDS", "60"))
    failures = 0
    while _running:
        try:
            escalated, expired = run_cycle()
            failures = 0
            if escalated or expired:
                log.info("cycle escalated=%d expired_reservations=%d", escalated, expired)
            delay = interval
        except SQLAlchemyError as exc:
            failures += 1
            # Exponential backoff with jitter while the database is unavailable; never crash-loop.
            delay = min(300, 2 ** min(failures, 8)) + random.uniform(0, 1)
            log.warning("cycle failed (%s); retrying in %.0fs", type(exc).__name__, delay)
        deadline = time.monotonic() + delay
        while _running and time.monotonic() < deadline:
            time.sleep(1)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
