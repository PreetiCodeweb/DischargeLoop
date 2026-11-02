CREATE TYPE reason_code AS ENUM (
  'CREATED',
  'RESERVATION_REQUESTED',
  'RESERVATION_CANCELLED',
  'RESERVATION_EXPIRED',
  'ADMISSION_CONFIRMED',
  'CLINICAL_BLOCK',
  'CLINICAL_UNBLOCK',
  'MAINTENANCE_STARTED',
  'MAINTENANCE_COMPLETED'
);

ALTER TABLE bed
  ALTER COLUMN state_reason_code TYPE reason_code USING state_reason_code::reason_code;
ALTER TABLE audit_event
  ALTER COLUMN reason_code TYPE reason_code USING reason_code::reason_code;

CREATE TABLE idempotency_request (
  actor_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  endpoint varchar(160) NOT NULL,
  request_hash char(64) NOT NULL,
  response_status smallint,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, idempotency_key),
  CHECK ((response_status IS NULL AND response_body IS NULL)
      OR (response_status BETWEEN 200 AND 599 AND response_body IS NOT NULL))
);
CREATE INDEX idempotency_expiry_idx ON idempotency_request (expires_at);
