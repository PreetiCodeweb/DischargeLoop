# M2 demo: bed state and reservations

This script exercises concurrency using a clean local database. Integration
fixtures exist only for the test run and are truncated afterward. Do not run
these tests against a populated hospital database.

```bash
docker compose -f ops/docker-compose.yml exec api npm run migrate
docker compose -f ops/docker-compose.yml exec api npm test
```

Expected:

- The exhaustive state-machine test accepts only listed transitions.
- Fifty concurrent reservation requests for one bed produce one success and
  49 `BED_NOT_AVAILABLE` errors.
- The same idempotency key replays the original reservation response.
- An expired hold returns the bed to `AVAILABLE` and writes one
  `ReservationExpired` outbox event, even when the expiry scan runs twice.
- Integration-created records are removed; the database remains free of
  patient/encounter/bed fixtures.

The expiry worker runs in Compose and checks every 30 seconds. API operations
require a valid Keycloak access token, server-side role authorization, and a
ward-scoped claim. Keycloak starts with role/client configuration and no
hospital users.
