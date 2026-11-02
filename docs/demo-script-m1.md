# M1 demo: schema and enforced database invariants

This walkthrough uses the local PostgreSQL database created by the M0 Compose
setup. It applies schema only; it does not insert patient, encounter, ward, or
bed records. The automated integration writes run inside transactions and roll
back before finishing.

```bash
docker compose -f ops/docker-compose.yml exec api npm run migrate
docker compose -f ops/docker-compose.yml exec api npm test
docker compose -f ops/docker-compose.yml exec api npm run migrate:down
docker compose -f ops/docker-compose.yml exec api npm run migrate
```

Expected:

- Migration up and down both complete. Rollback refuses to run if any domain
  table contains a row.
- The tests prove that entity + audit + outbox writes roll back together, audit
  cannot be updated or deleted through the app role, and a bed cannot receive
  two active assignments.
- After the tests, all domain tables remain empty. `schema_migrations` contains
  schema bookkeeping only.
