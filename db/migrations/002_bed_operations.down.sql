DROP TABLE IF EXISTS idempotency_request;
ALTER TABLE bed
  ALTER COLUMN state_reason_code TYPE varchar(48) USING state_reason_code::text;
ALTER TABLE audit_event
  ALTER COLUMN reason_code TYPE varchar(48) USING reason_code::text;
DROP TYPE IF EXISTS reason_code;
