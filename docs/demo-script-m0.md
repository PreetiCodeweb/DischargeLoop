# M0 demo: empty local DischargeLoop foundation

Run from the repository root. This walkthrough creates service containers and
an empty PostgreSQL volume. It does not add application records.

```bash
cp .env.example .env
# Edit the PostgreSQL admin/app/migration and Keycloak passwords in .env.
docker compose -f ops/docker-compose.yml up -d
docker compose -f ops/docker-compose.yml ps
curl -i http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/ready
```

Expected:

- PostgreSQL and Redis report healthy; API and web are running.
- `/health` returns `200` with `{"status":"ok"}` and an `X-Correlation-Id` header.
- `/ready` returns `503` with database/queue dependency status and EHR `not_configured`.
- `http://127.0.0.1:5173/` shows the DischargeLoop workspace shell and says there
  are no patient, bed, or demo records.

Stop the services with:

```bash
docker compose -f ops/docker-compose.yml down
```

`down` preserves the empty database volume. To preserve patient data in a later
milestone, never use `down -v` on an installation database.
