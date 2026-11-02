# Frontend/API handoff (M0)

This file is the integration boundary for frontend work. API behavior is
authoritative; the web client must not invent current bed, patient, or discharge
state.

## Available now

- `GET /health` is process liveness and returns `200 {"status":"ok"}`.
- `GET /ready` reports database, queue, and EHR dependency state. It returns
  `503` while any dependency is unknown/unavailable. M0 reports EHR as
  `not_configured` until a real adapter is verified.
- Every response includes `X-Correlation-Id`. A valid incoming value is echoed;
  otherwise the API creates one.
- There are no demo records or frontend mock records. Empty state is the only
  valid M0 data state.

## API evolution

The M2 bed endpoints below are available now. Further domain endpoints will be
added under `/api/v1` after their backend milestones are accepted. Do not render
a simulated bedboard, discharge, or task as live system state.

## Authentication and M2 endpoints

- OIDC client: `dischargeloop-web`, public client, Authorization Code + PKCE
  (`S256`). The API accepts bearer access tokens with issuer
  `http://localhost:8080/realms/dischargeloop` and audience `dischargeloop-api`.
- Realm roles are in `realm_access.roles`. Ward access comes from the
  `ward_ids` user attribute claim. `hospital:wide` is assigned through the
  `admin` and `auditor` composite roles.
- `GET /api/v1/beds?ward=<uuid>&state=<enum>` returns only beds in the caller's
  ward scope. `GET /api/v1/beds/{bedId}` returns current bed/assignment state.
- `POST /api/v1/reservations` expects
  `{ "bedId": "<uuid>", "reasonCode": "RESERVATION_REQUESTED", "ttlSeconds": 1800 }`.
  TTL is 30 minutes by default; only coordinator/admin may extend it, up to two
  hours. Responses include reservation and expiry details.
- Reservation confirmation uses `POST /api/v1/reservations/{id}/confirm` with
  `encounterId` and `ADMISSION_CONFIRMED`; cancel uses `DELETE
  /api/v1/reservations/{id}` with `RESERVATION_CANCELLED`.
- Every mutation requires `Idempotency-Key` and `X-Correlation-Id`. State
  changes commit together with their audit and outbox event. Stable domain
  errors use `application/problem+json` and a `code`.
- Do not optimistically paint a bed AVAILABLE. The backend reservation result
  and current bedboard response are authoritative.
