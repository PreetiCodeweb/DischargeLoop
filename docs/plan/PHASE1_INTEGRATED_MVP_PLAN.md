# DischargeLoop — Phase 1: Integrated Platform + MVP Features 1–5 (US / HIPAA / Epic)

Status legend: [ ] todo · [~] in progress · [x] done

## Decisions (approved 2026-11-12)

| Topic | Decision |
|---|---|
| First market | United States: HIPAA, Epic (HL7 v2 via Epic Bridges/interface engine; SMART on FHIR next phase) |
| Architecture | **Option A — one platform**: FastAPI backend + Next.js frontend + one PostgreSQL 16. DischargeLoop is the product; MedSync becomes its *Command Center* module |
| Home repo | `PreetiCodeweb/DischargeLoop` (branch `feat-mvp-integrated-platform`); MedSync code imported as the Command Center module |
| Legacy code | Django HMS and NestJS/Vite (`apps/`) removed from the tree in a dedicated commit (recoverable from git history) |
| Auth (this phase) | Native JWT (bcrypt) + role/ward RBAC + 15 min idle timeout + login lockout, behind an OIDC-ready interface. Keycloak/SSO + Epic SMART launch next phase |
| Restricted networks | Where `registry.npmjs.org` is blocked, the frontend can be built on the host and shipped via `Dockerfile.prebuilt` |
| Runtime | Docker Compose project `dischargeloop`, loopback-only configurable ports (default 3001/8001/2576/5434). Cloud deployment is a later phase |

## Single source of truth

- Schema `dischargeloop` (migrations `db/migrations/001–004` from the teammate + new `005+`) is the system of record for hospital, ward, bed, patient, encounter, bed_assignment (reservations), discharge, task, blocker, escalation, cleaning, audit_event, outbox, HL7 log/quarantine.
- MedSync tables (`public` schema, `db/medsync/*.sql`) keep only Command Center concerns: users/identity, historical metrics, forecasts, recommendations, alerts, simulation. MedSync's own beds/admissions/bed-orders are retired: Command Center reads DischargeLoop capacity through SQL views; ICU "bed orders" become DischargeLoop reservations.
- Business rules live in the application (Python, unit-tested). DB triggers are kept only for integrity/audit (append-only audit, constraints). The teammate's `manage_discharge_reversal` and `auto_complete_task_from_hl7` triggers are replaced by tested service code (they duplicated logic and caused defect #1).
- Least privilege: migrations run as `dischargeloop_migrator`; the API runs as `dischargeloop_app` (no UPDATE/DELETE on audit).

## Defects to fix (each with a regression test)

1. `CANCELLED_REVERSED` unreachable: legal from MEDICALLY_CLEARED / TASKS_PENDING / READY_TO_DEPART; restart CANCELLED_REVERSED → INITIATED. Reversal: bed stays OCCUPIED, active reservations for that bed cancelled, open tasks cancelled, outbox `DischargeReversed`, high-priority notification.
2. Free-text reversal reason persisted (`discharge.reversal_reason`); correct reason code per transition in audit.
3. CORS/method allow-list includes PATCH (and same-origin proxy is the default path).

## MVP features (US / Epic)

1. **Discharge worklist** — per ward: patient, bed, discharge state, expected discharge (EDD), current top blocker, next action/owner, hours since medically ready, overdue count; live refresh (SSE).
2. **Named task ownership** — owner = functional role scoped to ward (`role@WARD`, e.g. `pharmacist@4A`); claim/complete/cancel; due time; DB constraint: no ownerless task.
3. **Blocker tracking** — `blocker` entity: category (MEDICATION_RECONCILIATION, LABS, PT_OT_CLEARANCE, DISCHARGE_SUMMARY, PRIOR_AUTH_INSURANCE, TRANSPORT, DME_EQUIPMENT, POST_ACUTE_PLACEMENT, FAMILY_CAREGIVER, OTHER), side INTERNAL/EXTERNAL, external party, opened/resolved; enables delay-by-category metrics. Open blocking items prevent READY_TO_DEPART.
4. **Escalations & reminders** — configurable `escalation_policy` (task type/category → after N minutes overdue → notify role, level n); background worker (idempotent, one notification per task/level); in-app notifications. No PHI over SMS/email until a BAA vendor is chosen.
5. **Simple EHR integration** — HL7 v2 over HTTPS from the interface engine (Epic Bridges → Mirth/Redox → `POST /api/v1/integrations/hl7`), token-authenticated: ADT A01/A02/A03/A08/A11/A12/A13/A16/A25; ACK (AA/AE/AR); idempotent on MSH-10; Epic location (PV1-3) → ward/bed mapping; quarantine on mismatch; ORU/RDE/ORM → task auto-completion via rules table. Simulator script for local testing.

## HIPAA (this phase)

PHI read-access audit (who viewed which patient), ward-scoped minimum necessary, idle timeout + lockout, no PHI in logs, synthetic data only, injury detection behind a "demo — not for clinical use" flag (potential FDA SaMD). EC2 phase: TLS, encrypted EBS, AWS BAA before real PHI, backups.

## Technical notes from reading the teammate's code (keep in mind while porting)

- Migrations 001–004 use unqualified table names; the runner sets `search_path TO dischargeloop, public`, takes `pg_advisory_lock(hashtext('dischargeloop:schema-migrations'))`, records names in `dischargeloop.schema_migrations`, one transaction per file. 001 hardcodes role names `dischargeloop_app` / `dischargeloop_migrator` (REVOKE/GRANT); `ops/postgres-init/001-roles.sh` creates both roles + schema `dischargeloop` (owner migrator) + default privileges.
- 001: `audit_event` (actor_id uuid NOT NULL, actor_role, action, entity_type, entity_id, before_state, after_state NOT NULL, reason_code, correlation_id NOT NULL, request_id) append-only via trigger. `task` CHECK: DONE/CANCELLED need completed_at. `cleaning` CHECK verified_by <> accepted_by; one open cleaning per bed. `bed_assignment`: one ACTIVE per bed (partial unique) — an OCCUPIED bed cannot also hold an ACTIVE reservation.
- 002: `reason_code` enum (CREATED, RESERVATION_REQUESTED/CANCELLED/EXPIRED, ADMISSION_CONFIRMED, CLINICAL_BLOCK/UNBLOCK, MAINTENANCE_STARTED/COMPLETED) used by `bed.state_reason_code` and `audit_event.reason_code`; `idempotency_request` (PK actor_id+idempotency_key, no `id` column).
- 003: re-creates `discharge_state` with CANCELLED_REVERSED; extends reason_code (+DISCHARGE_CANCELLED_REVERSED, DISCHARGE_PENDING, TASK_AUTO_COMPLETED, REFERRAL_SCRUBBED, EXTERNAL_PARTNER_ACCEPTED/DECLINED); `hl7_event_type` enum (ADT_A01…A25, ORM, ORU, RDE); tables external_partner, referral, referral_scrubber, hl7_event_log, fhir_launch_context; triggers `trigger_hl7_task_auto_complete` + `trigger_discharge_state` (manage_discharge_reversal; also forces version+1 on every discharge UPDATE). It DROPPED 001's `discharge_check` (CANCELLED needs reason) — 005 must restore it.
- 004: TTL config/log + cleanup functions; bug: `cleanup_expired_idempotency_requests` references non-existent `idempotency_request.id` — 005 must replace it. `archive_old_audit_events` only counts (no delete) — fine with append-only audit.
- Bed transitions (TS): AVAILABLE→RESERVED/BLOCKED/MAINTENANCE; RESERVED→AVAILABLE/OCCUPIED; OCCUPIED→CLEANING/BLOCKED/MAINTENANCE; CLEANING/BLOCKED/MAINTENANCE→AVAILABLE. CLEANING→AVAILABLE only via two-person cleaning verify.
- MedSync: FastAPI app with `app_users` (bcrypt, roles enum user_role), public-schema hospitals/departments/beds/patients/admissions/bed_orders/historical_metrics/alerts/recommendations; routes auth/admin/dashboard/forecast/operations/simulation; Next.js 15 + React 19 frontend with custom path router in `app/App.tsx`; hardened compose + `Dockerfile.prebuilt` + `scripts/build-frontend-prebuilt.sh` for npm-restricted networks.

## Work breakdown (status: complete)

- [x] P0 Repo restructure: legacy Django HMS, `apps/` (NestJS/Vite) and `ops/docker-compose.yml` removed; MedSync `backend/`,
  `frontend/` and `db/medsync/` imported; `ops/postgres-init/001-roles.sh` (least-privilege roles, schemas, extensions);
  `backend/app/db_migrate.py` (ordered, idempotent, advisory-locked migration runner).
- [x] P1 Migration 005: reversal reason, EDD, blockers, notifications, escalation, HL7 location map + rules, PHI access log,
  ward department type, Command Center capacity view; logic triggers replaced by tested application code.
- [x] P2 Backend (`backend/app/discharge/`): domain state machines, service layer (audit + outbox + notifications per change),
  escalation worker, HL7 ingestion, REST API; auth lockout and 15-minute tokens.
- [x] P3 Frontend: worklist, discharge detail, my tasks, beds & turnover, alerts, EHR feed & outcomes; Command Center reads
  DischargeLoop capacity; idle logoff.
- [x] P4 Tests: unit + PostgreSQL integration tests; live end-to-end script `scripts/e2e_smoke.py`.
- [x] P5 Docker Compose stack (postgres, migrate, backend, worker, frontend) verified end to end incl. restart persistence.
- [x] P6 Docs: README, AGENTS.md.

### Fixes found while verifying end to end

- Admins can provision every functional role and assign wards (`GET/PUT /api/v1/dl/users/{id}/wards`, audited).
- Safety: after a clinical reversal and restart, checklist work completed before the restart is regenerated.
- Clock skew: lifecycle timestamps use the database clock (`DB_NOW` → `now()`), not the API host clock.
- Only the owning role may claim/complete a task; coordinators may cancel. UI hides actions for non-owners.
- MedSync's fixed-password demo accounts are disabled by seed `002`; `/dl/meta` requires authentication.
