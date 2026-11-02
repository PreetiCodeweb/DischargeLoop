# ADR-0003: Data invariants and transaction boundary

- Status: Accepted
- Date: 2026-11-02

## Context

Bed allocation and discharge require a single authoritative state and must not
commit without their audit and outbox records. The database is PostgreSQL 16.
The application runtime must not own schema objects or be able to rewrite audit
history.

## Decision

- Use an application schema `dischargeloop`, owned by a separate migration role.
- The API connects with a non-owner `dischargeloop_app` role; migrations use
  `dischargeloop_migrator`.
- Generate UUIDv7 identifiers in the application. PostgreSQL stores them as UUID
  and does not choose IDs.
- Store exactly one `bed.state` enum. Availability is never duplicated in a
  boolean flag. A partial unique index permits one active assignment per bed.
- Each future transition uses `UnitOfWork.transaction`; the service will write
  bed/discharge state, audit, and outbox rows in that same transaction.
- Audit rows have an immutable trigger, and the runtime role receives only
  SELECT and INSERT permissions for the audit table.
- Patient identity is unique by hospital + external HIS identifier. Clinical
  diagnoses and notes are not part of this product schema.
- No sample or demo records are inserted by migrations, startup, or CI.

## Consequences

- Migrations must run with `MIGRATION_DATABASE_URL`; the runtime API must use
  `DATABASE_URL`.
- SQLite cannot provide the required partial indexes and row locks; the new
  domain uses PostgreSQL only.
- A DB-level uniqueness constraint prevents two active bed assignments, while
  the M2 service must additionally lock the bed row and guard transitions.
- Audit immutability is enforced both by database permissions and a trigger.
