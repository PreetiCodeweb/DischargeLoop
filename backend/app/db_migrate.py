"""Apply database migrations in a fixed order, once each, under an advisory lock.

Order: MedSync Command Center schema (schema ``medsync``), then the DischargeLoop
system-of-record schema (``dischargeloop``), then reporting views, then optional
synthetic demo seeds. Runs as the migrator role; the API never has DDL rights.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import psycopg

DB_ROOT = Path(os.environ.get("MIGRATIONS_DIR", Path(__file__).resolve().parents[2] / "db"))
_TX_LINE = re.compile(r"^\s*(BEGIN|COMMIT)\s*;\s*$", re.IGNORECASE | re.MULTILINE)


def _steps(seed_demo: bool) -> list[tuple[str, Path, str]]:
    steps = [(f"medsync/{p.stem}", p, "medsync, public") for p in sorted((DB_ROOT / "medsync" / "migrations").glob("*.sql"))]
    steps += [(p.name[: -len(".up.sql")], p, "dischargeloop, medsync, public") for p in sorted((DB_ROOT / "migrations").glob("*.up.sql"))]
    steps += [(f"medsync/views/{p.stem}", p, "medsync, public") for p in sorted((DB_ROOT / "medsync" / "views").glob("*.sql"))]
    if seed_demo:
        steps += [(f"seed/medsync/{p.stem}", p, "medsync, public") for p in sorted((DB_ROOT / "medsync" / "seeds").glob("*.sql"))]
        steps += [(f"seed/dischargeloop/{p.stem}", p, "dischargeloop, medsync, public") for p in sorted((DB_ROOT / "seeds").glob("*.sql"))]
    return steps


def migrate(database_url: str, seed_demo: bool = False) -> list[str]:
    applied: list[str] = []
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(hashtext('dischargeloop:schema-migrations'))")
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS dischargeloop.schema_migrations ("
                " name varchar(200) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            for name, path, search_path in _steps(seed_demo):
                if conn.execute("SELECT 1 FROM dischargeloop.schema_migrations WHERE name = %s", (name,)).fetchone():
                    continue
                # Some imported files carry their own BEGIN/COMMIT; each step runs in exactly one transaction here.
                sql = _TX_LINE.sub("", path.read_text(encoding="utf-8"))
                with conn.transaction():
                    conn.execute(f"SET LOCAL search_path TO {search_path}")
                    conn.execute(sql)
                    conn.execute("INSERT INTO dischargeloop.schema_migrations (name) VALUES (%s)", (name,))
                applied.append(name)
                print(f"applied {name}", flush=True)
        finally:
            conn.execute("SELECT pg_advisory_unlock(hashtext('dischargeloop:schema-migrations'))")
    return applied


if __name__ == "__main__":
    url = os.environ.get("MIGRATION_DATABASE_URL")
    if not url:
        sys.exit("MIGRATION_DATABASE_URL is required")
    migrate(url.replace("postgresql+psycopg://", "postgresql://"), seed_demo=os.environ.get("SEED_DEMO", "false").lower() == "true")
