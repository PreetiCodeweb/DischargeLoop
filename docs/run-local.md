# Running DischargeLoop locally (no Docker)

Everything below runs on one machine without Docker.

## 1. Database

Use any Postgres 16+ instance and point the API at it, then apply the schema:

```bash
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/dischargeloop"
for f in db/migrations/00*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

## 2. API

```bash
cd apps/api
npm ci
npm run build
AUTH_MODE=dev DATABASE_URL="$DATABASE_URL" PORT=3010 node dist/main.js
```

`AUTH_MODE=dev` issues local HS256 tokens from the persona picker on the login
screen (admin, admission, clinical, coordinator, housekeeping, bed_manager,
pharmacy, billing, transport, auditor). Never use it outside local development.

Seed demo data (3 wards, 24 beds, 11 patients, one open cleaning job, one
in-flight discharge):

```bash
cd apps/api && npm run seed
```

## 3. Web

```bash
cd apps/web
npm ci
npm run dev     # http://localhost:5173  (proxies /api to 127.0.0.1:3010)
```

Production build: `npm run build` in `apps/web`, then serve `apps/web/dist`
behind the API.

## 4. The loop you can walk through

1. **Admissions** (as `admission`): create patient → encounter → reserve bed →
   confirm admission. Bed goes AVAILABLE → RESERVED → OCCUPIED.
2. **Discharges** (as `coordinator`): initiate → medically cleared → handoff
   tasks fan out by role.
3. **Tasks** (as `pharmacy`, `billing`, `clinical`, `transport`): claim and
   complete your handoff tasks; blocking tasks gate departure.
4. **Discharges**: mark ready to depart → confirm departure. The bed flips to
   CLEANING and a cleaning job is queued.
5. **Housekeeping** (as `housekeeping`): accept the job. Bed stays CLEANING.
6. **Housekeeping / bed manager** (as `bed_manager`, a second person): verify
   clean. Bed returns to AVAILABLE and can be admitted again.
7. **Audit** (as `auditor` or admin): every transition with actor role and
   before → after state.
