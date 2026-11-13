# DischargeLoop

Discharge and handoff coordination that sits **beside** the hospital EHR (Epic first, US / HIPAA),
with the MedSync **Command Center** (capacity, forecasting, simulation) as an integrated module.

> Make discharge work visible and close the handoff — without replacing the EHR.

DischargeLoop does not replace Epic's bed board or a post-acute referral network. It owns what they leave open:
who owns each remaining discharge step across departments, what is blocking it (internal vs external), when it is
late, and closing those steps automatically from the EHR feed.

## Features

| # | Feature | Where |
|---|---|---|
| 1 | Discharge worklist: status, expected discharge, top blocker, next owner, hours since medically cleared | `/worklist` |
| 2 | Named task ownership: functional role on a ward (`pharmacist@4A`); only the owning role can claim/complete | `/tasks`, discharge detail |
| 3 | Blocker tracking: categorised, **internal vs external** (external requires the named party) | discharge detail, `/integration` |
| 4 | Escalations & reminders: policy-driven, idempotent, in-app (no PHI over SMS/email) | `/notifications`, worker |
| 5 | EHR integration: HL7 v2 over **MLLP** (direct from Epic Bridges) or HTTPS; ACKs; idempotent on MSH-10; quarantine | `mllp` service, `POST /api/v1/integrations/hl7` |
| + | Important Message from Medicare: initial (≤2 days after admission) and follow-up (blocking) tasks | auto-created for Medicare inpatients |
| + | Operability: readiness, Prometheus metrics, PHI-free JSON logs, stale-EHR-feed alert and banner | `/ready`, `/metrics` |

Discharge lifecycle: `INITIATED → MEDICALLY_CLEARED → TASKS_PENDING → READY_TO_DEPART → DEPARTED`, with
`CANCELLED_REVERSED` (the "2 PM fever": the bed stays occupied, holds are released, open work is cancelled,
critical alerts fire, the reason is recorded) and restart back to `INITIATED` with the checklist regenerated.
A bed returns to `AVAILABLE` only after two different people accept and verify its cleaning.

HL7 v2 events handled: ADT A01, A02, A03, A04, A05, A06, A07, A08, A11, A12/A13 (to review), A16, A17 (bed swap),
A21/A22 (leave of absence), A25, A34/A40 (patient merge); ORU/ORM/RDE auto-complete matching tasks. Late or replayed
messages never move a patient backwards; timestamps without an offset use the hospital's timezone.

## Architecture

```
Epic Bridges / interface engine ─MLLP(S)─► mllp ─┐
                                 ─HTTPS──► FastAPI (backend/app)
                                                  ├── discharge/   DischargeLoop domain, services, HL7, escalation
                                                  ├── api/routes/  MedSync Command Center + auth
Next.js (frontend/) ── same-origin /api proxy ───►└── PostgreSQL 16
                                                       ├── schema dischargeloop  system of record (beds, encounters, discharges, tasks, blockers, audit, outbox, HL7)
                                                       └── schema medsync        users + analytics
worker (escalations, reservation expiry, feed health) ─► same database (SKIP LOCKED, idempotent)
```

- Business rules live in tested application code; the database enforces integrity (constraints, append-only audit and PHI-access logs).
- Least privilege: migrations run as `dischargeloop_migrator`; the API runs as `dischargeloop_app` (no DDL, cannot alter audit).
- HIPAA (this phase): PHI read-access log, ward-scoped access, 15-minute idle logoff with warning, login lockout, synthetic data only.
  Before any real PHI: TLS, encrypted storage, backups and a signed BAA with the hosting provider.
- Accessibility: WCAG 2.1 AA work (skip link, landmarks, labelled controls, table semantics, timeout warning).

## Prerequisites

Git, Docker with Compose v2 (≥ 6 GB RAM for Docker), and optionally Python 3.12 and Node.js 22 for running tests outside Docker.
Windows: use WSL2.

## Run locally (Docker)

```bash
./scripts/init-env.sh          # creates .env (prompts for admin/demo passwords, generates every other secret)
docker compose up -d --build
docker compose ps              # postgres, backend, worker, mllp, frontend healthy; migrate "Exited (0)"
```

| What | Where |
|---|---|
| Web app | http://127.0.0.1:3001 |
| API docs | http://127.0.0.1:8001/docs |
| HL7 MLLP listener | 127.0.0.1:2576 |
| PostgreSQL | 127.0.0.1:5434 |
| Health / readiness / metrics | `/health`, `/ready`, `/metrics` on the API |

- Admin: `roselyn_yu@northstar.example` with the admin password you entered.
- Demo staff (if a demo password was entered): `doctor.4a@`, `nurse.4a@`, `cm.4a@`, `pharm.4a@`, `evs1.4a@`, `evs2.4a@`,
  `transport.4a@`, `beds@` — all `@northstar.example`.
- Ports are configurable in `.env` (`DL_HTTP_PORT`, `DL_API_PORT`, `DL_MLLP_PORT`, `DL_DB_PORT`). The configuration template is
  `docker.env.example`.
- Networks that block `registry.npmjs.org`: `./scripts/build-frontend-prebuilt.sh` (needs an existing `frontend/node_modules`),
  then set `DL_FRONTEND_DOCKERFILE=Dockerfile.prebuilt` in `.env`.

## Tests

```bash
cd backend
python -m pytest -q tests                      # unit tests (database tests are skipped)
DL_TEST_DATABASE_URL="postgresql+psycopg://dischargeloop_app:$(grep '^DL_APP_DB_PASSWORD=' ../.env | cut -d= -f2-)@127.0.0.1:5434/dischargeloop" \
  python -m pytest -q tests                    # + discharge loop, HL7 real-world cases, MLLP against a migrated database
cd ../frontend && npx tsc --noEmit && npx eslint . --max-warnings=0 && npm run build
cd .. && python3 scripts/e2e_smoke.py          # live end-to-end walk-through of the running stack
```

## Send a test HL7 message

Over MLLP, as Epic Bridges does:

```bash
printf '\x0bMSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112093000||ADT^A16|DEMO-A16-1|P|2.5.1\rPID|1||MRN000001\rPV1|1|I|4A^^4A-01||||||||||||||||V00000001\r\x1c\r' |
  nc 127.0.0.1 2576
```

Over HTTPS (for interface engines that post messages):

```bash
printf 'MSH|^~\\&|EPIC|NSGH|DISCHARGELOOP|NSGH|20261112093000||ADT^A16|DEMO-A16-2|P|2.5.1\rPID|1||MRN000001\rPV1|1|I|4A^^4A-01||||||||||||||||V00000001\r' |
  curl -sS -X POST http://127.0.0.1:8001/api/v1/integrations/hl7 \
       -H "Authorization: Bearer $(grep '^DL_HL7_INGEST_TOKEN=' .env | cut -d= -f2-)" \
       -H 'Content-Type: application/hl7-v2' --data-binary @-
```

## Contributing

- Work on a feature branch and open a pull request into `main`; CI runs backend tests against PostgreSQL and the frontend checks.
- Never commit `.env` (git-ignored). Each developer creates their own with `./scripts/init-env.sh`.
- Schema changes are new files in `db/migrations/` (`NNN_name.up.sql` + `.down.sql`); never edit an applied migration.
- Synthetic data only — never real patient information.

## Documentation

- `docs/plan/PHASE1_INTEGRATED_MVP_PLAN.md` — integrated platform and MVP decisions
- `docs/plan/PHASE2_GO_LIVE_PLAN.md` — path to a US hospital go-live (Epic, security review, onboarding, edge cases)
- `docs/plan/US_HOSPITAL_INTEGRATION_RESEARCH.md` — sourced research on hospital systems, Epic integration and regulations
- `docs/adr/` — earlier architecture decision records
- `AGENTS.md` — run and verification commands for contributors and coding agents

## License

See `LICENSE`.
