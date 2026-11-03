-- Migration 003 Down: Rollback Discharge Enhancement Architecture

-- 1. Drop indexes
DROP INDEX IF EXISTS idx_discharge_reversal;
DROP INDEX IF EXISTS idx_fhir_launch_expiry;
DROP INDEX IF EXISTS idx_fhir_launch_encounter;
DROP INDEX IF EXISTS idx_hl7_event_discharge;
DROP INDEX IF EXISTS idx_hl7_event_status;
DROP INDEX IF EXISTS idx_hl7_event_encounter;
DROP INDEX IF EXISTS idx_referral_scrubber_referral;
DROP INDEX IF EXISTS idx_referral_token;
DROP INDEX IF EXISTS idx_referral_partner;
DROP INDEX IF EXISTS idx_referral_discharge;
DROP INDEX IF EXISTS idx_external_partner_hospital;

-- 2. Drop constraint
ALTER TABLE discharge DROP CONSTRAINT IF EXISTS check_reversal_reason;

-- 3. Drop triggers and functions
DROP TRIGGER IF EXISTS trigger_discharge_state ON discharge;
DROP FUNCTION IF EXISTS manage_discharge_reversal();

DROP TRIGGER IF EXISTS trigger_hl7_task_auto_complete ON hl7_event_log;
DROP FUNCTION IF EXISTS auto_complete_task_from_hl7();

-- 4. Drop tables
DROP TABLE IF EXISTS fhir_launch_context;
DROP TABLE IF EXISTS hl7_event_log;
DROP TABLE IF EXISTS referral_scrubber;
DROP TABLE IF EXISTS referral;
DROP TABLE IF EXISTS external_partner;

-- 5. Drop HL7 event type enum
DROP TYPE IF EXISTS hl7_event_type;

-- 6. Restore original reason_code enum (remove new values)
CREATE TYPE reason_code_new AS ENUM (
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

ALTER TABLE bed ALTER COLUMN state_reason_code TYPE reason_code_new USING state_reason_code::text::reason_code_new;
ALTER TABLE audit_event ALTER COLUMN reason_code TYPE reason_code_new USING reason_code::text::reason_code_new;

DROP TYPE reason_code;
ALTER TYPE reason_code_new RENAME TO reason_code;

-- 7. Restore original discharge_state enum (remove CANCELLED_REVERSED)
CREATE TYPE discharge_state_new AS ENUM (
  'INITIATED',
  'MEDICALLY_CLEARED',
  'TASKS_PENDING',
  'READY_TO_DEPART',
  'DEPARTED',
  'CANCELLED'
);

ALTER TABLE discharge ALTER COLUMN state TYPE discharge_state_new USING state::text::discharge_state_new;

DROP TYPE discharge_state;
ALTER TYPE discharge_state_new RENAME TO discharge_state;
