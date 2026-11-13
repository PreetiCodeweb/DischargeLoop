# DischargeLoop — contributor & agent notes

Plans, decisions and progress: `docs/plan/PHASE1_INTEGRATED_MVP_PLAN.md`, `docs/plan/PHASE2_GO_LIVE_PLAN.md`,
research: `docs/plan/US_HOSPITAL_INTEGRATION_RESEARCH.md`.

## Environment
- Everything runs with Docker Compose (project `dischargeloop`). Ports bind to loopback and are configurable in `.env`
  (defaults: web 3001, API 8001, MLLP 2576, Postgres 5434).
- Ops endpoints: `/health` (liveness), `/ready` (DB + schema), `/metrics` (Prometheus text; optional METRICS_TOKEN).
- `.env` is created per developer with `scripts/init-env.sh`. Never commit it and never print its values.
- Networks that block `registry.npmjs.org`: build the frontend on the host with `scripts/build-frontend-prebuilt.sh`
  and set `DL_FRONTEND_DOCKERFILE=Dockerfile.prebuilt` in `.env`.
- Commits must use your own git identity; work on a branch and open a pull request into `main`.

## Run
```bash
docker compose up -d --build                     # or: docker compose build migrate frontend && docker compose up -d
```

## Verify (all must pass)
```bash
cd frontend && npx tsc --noEmit && npx eslint . --max-warnings=0
cd backend && DL_TEST_DATABASE_URL=postgresql+psycopg://dischargeloop_app:<app-db-password>@127.0.0.1:5434/dischargeloop python -m pytest -q tests
python3 scripts/e2e_smoke.py                     # live stack through the web proxy (creates and deletes its own staff)
```

## Rules of the domain (do not regress)
- Business rules live in `backend/app/discharge/` (tested); DB triggers only for integrity/append-only audit.
- Lifecycle timestamps use the DB clock (`DB_NOW` → `now()`), never the app host clock.
- HL7 timestamps without an offset are hospital local time; late/replayed ADT must never move a patient backwards.
- Only the owning role may claim/complete a task; coordinators may cancel. A bed leaves CLEANING only via two-person verification.
- After a clinical reversal + restart, pre-restart completed checklist work is stale and regenerated.
- No PHI in logs, metrics or push notifications; synthetic data only.
