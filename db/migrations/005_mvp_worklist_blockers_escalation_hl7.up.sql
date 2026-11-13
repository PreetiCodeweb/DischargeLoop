-- Migration 005: Phase 1 MVP (features 1-5) + defect fixes + MedSync integration hooks.
-- Business rules move to tested application code; triggers stay only for integrity/audit.

-- 0. Remove logic triggers that duplicated (and conflicted with) application rules.
DROP TRIGGER IF EXISTS trigger_discharge_state ON discharge;
DROP FUNCTION IF EXISTS manage_discharge_reversal();
DROP TRIGGER IF EXISTS trigger_hl7_task_auto_complete ON hl7_event_log;
DROP FUNCTION IF EXISTS auto_complete_task_from_hl7();

-- 1. Reason codes for every state change (defect: everything was audited as DISCHARGE_PENDING).
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'DISCHARGE_INITIATED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'DISCHARGE_MEDICALLY_CLEARED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'DISCHARGE_TASKS_PENDING';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'DISCHARGE_READY_TO_DEPART';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'DISCHARGE_DEPARTED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'DISCHARGE_CANCELLED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'DISCHARGE_RESTARTED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'DISCHARGE_EDD_UPDATED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'TASK_CREATED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'TASK_CLAIMED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'TASK_COMPLETED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'TASK_CANCELLED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'TASK_ESCALATED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'BLOCKER_OPENED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'BLOCKER_RESOLVED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'BLOCKER_CANCELLED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'CLEANING_REQUESTED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'CLEANING_ACCEPTED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'CLEANING_VERIFIED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'PATIENT_DEPARTED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'ENCOUNTER_ADMITTED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'ENCOUNTER_TRANSFERRED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'ENCOUNTER_UPDATED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'ENCOUNTER_CANCELLED';

-- 2. Discharge: reversal reason (defect), expected discharge date (F1), source.
ALTER TABLE discharge ADD COLUMN reversal_reason varchar(500);
ALTER TABLE discharge ADD COLUMN reversed_at timestamptz;
ALTER TABLE discharge ADD COLUMN reversal_count integer NOT NULL DEFAULT 0 CHECK (reversal_count >= 0);
ALTER TABLE discharge ADD COLUMN expected_discharge_at timestamptz;
ALTER TABLE discharge ADD COLUMN source varchar(24) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'HL7_A16'));
ALTER TABLE discharge DROP CONSTRAINT IF EXISTS check_reversal_reason;
ALTER TABLE discharge ADD CONSTRAINT discharge_cancel_reason_required
  CHECK (state <> 'CANCELLED' OR cancelled_reason_code IS NOT NULL);
ALTER TABLE discharge ADD CONSTRAINT discharge_reversal_reason_required
  CHECK (state <> 'CANCELLED_REVERSED' OR length(btrim(coalesce(reversal_reason, ''))) > 0);
CREATE INDEX discharge_state_idx ON discharge (state, expected_discharge_at);

-- 3. Wards map to MedSync department types for the Command Center.
ALTER TABLE ward ADD COLUMN department_type varchar(32)
  CHECK (department_type IS NULL OR department_type IN ('ICU', 'EMERGENCY', 'WARD', 'OPERATING_ROOM', 'ISOLATION'));

-- 4. F3 Blockers: internal vs external, categorised, timed.
CREATE TYPE blocker_category AS ENUM (
  'MEDICATION_RECONCILIATION', 'LABS', 'PT_OT_CLEARANCE', 'DISCHARGE_SUMMARY', 'PRIOR_AUTH_INSURANCE',
  'TRANSPORT', 'DME_EQUIPMENT', 'POST_ACUTE_PLACEMENT', 'FAMILY_CAREGIVER', 'OTHER'
);
CREATE TYPE blocker_side AS ENUM ('INTERNAL', 'EXTERNAL');
CREATE TYPE blocker_status AS ENUM ('OPEN', 'RESOLVED', 'CANCELLED');

CREATE TABLE blocker (
  id uuid PRIMARY KEY,
  discharge_id uuid NOT NULL REFERENCES discharge(id) ON DELETE RESTRICT,
  category blocker_category NOT NULL,
  side blocker_side NOT NULL,
  status blocker_status NOT NULL DEFAULT 'OPEN',
  description varchar(280) NOT NULL CHECK (length(btrim(description)) > 0),
  external_party varchar(160),
  owner_role varchar(48) NOT NULL CHECK (length(btrim(owner_role)) > 0),
  owner_ward_id uuid REFERENCES ward(id) ON DELETE RESTRICT,
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_note varchar(280),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'OPEN' AND resolved_at IS NULL) OR (status <> 'OPEN' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)),
  CHECK (side = 'INTERNAL' OR length(btrim(coalesce(external_party, ''))) > 0)
);
CREATE INDEX blocker_discharge_status_idx ON blocker (discharge_id, status);
CREATE INDEX blocker_category_idx ON blocker (category, side, status);

-- 5. F2 Named ownership: functional role scoped to a ward (role@WARD); never ownerless.
ALTER TABLE task ADD COLUMN owner_ward_id uuid REFERENCES ward(id) ON DELETE RESTRICT;
ALTER TABLE task ADD COLUMN blocker_id uuid REFERENCES blocker(id) ON DELETE RESTRICT;
ALTER TABLE task ADD COLUMN source varchar(24) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'TEMPLATE', 'HL7'));
ALTER TABLE task ADD COLUMN last_escalated_at timestamptz;
ALTER TABLE task ADD CONSTRAINT task_owner_role_present CHECK (length(btrim(owner_role)) > 0);
CREATE INDEX task_discharge_status_idx ON task (discharge_id, status);
CREATE INDEX task_open_due_idx ON task (due_at) WHERE status IN ('OPEN', 'CLAIMED');

-- 6. F4 Escalation policy defaults ('*' = any task type) and in-app notifications.
ALTER TABLE escalation_policy ADD COLUMN is_active boolean NOT NULL DEFAULT true;
INSERT INTO escalation_policy (id, task_type, level, after_minutes, notify_role) VALUES
  ('00000000-0000-7005-8000-000000000001', '*', 1, 0,   'OWNER'),
  ('00000000-0000-7005-8000-000000000002', '*', 2, 60,  'case_manager'),
  ('00000000-0000-7005-8000-000000000003', '*', 3, 120, 'operations_manager')
ON CONFLICT (task_type, level) DO NOTHING;

CREATE TABLE notification (
  id uuid PRIMARY KEY,
  recipient_role varchar(48) NOT NULL,
  recipient_ward_id uuid REFERENCES ward(id) ON DELETE RESTRICT,
  kind varchar(48) NOT NULL,
  severity varchar(16) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  title varchar(160) NOT NULL,
  body varchar(500) NOT NULL,
  entity_type varchar(48),
  entity_id uuid,
  dedupe_key varchar(200) NOT NULL UNIQUE,
  read_at timestamptz,
  read_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_inbox_idx ON notification (recipient_role, recipient_ward_id, created_at DESC);

-- 7. F5 HL7 v2: idempotency on MSH-10, ACK code, location mapping, auto-completion rules.
ALTER TABLE hl7_event_log ADD COLUMN ack_code varchar(2) CHECK (ack_code IS NULL OR ack_code IN ('AA', 'AE', 'AR'));
CREATE UNIQUE INDEX hl7_event_control_id_uniq ON hl7_event_log (source_system, message_control_id) WHERE message_control_id IS NOT NULL;

CREATE TABLE hl7_location_map (
  id uuid PRIMARY KEY,
  source_system varchar(80) NOT NULL,
  point_of_care varchar(40) NOT NULL,
  room varchar(40) NOT NULL DEFAULT '',
  bed varchar(40) NOT NULL DEFAULT '',
  ward_id uuid NOT NULL REFERENCES ward(id) ON DELETE RESTRICT,
  bed_id uuid REFERENCES bed(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, point_of_care, room, bed)
);

CREATE TABLE hl7_task_rule (
  id uuid PRIMARY KEY,
  event_type hl7_event_type NOT NULL,
  match_code varchar(80) NOT NULL DEFAULT '*',
  task_type varchar(48) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, match_code, task_type)
);
INSERT INTO hl7_task_rule (id, event_type, match_code, task_type) VALUES
  ('00000000-0000-7005-8000-000000000101', 'RDE', '*', 'MEDS_RECONCILIATION'),
  ('00000000-0000-7005-8000-000000000102', 'ORU', '*', 'FINAL_LABS'),
  ('00000000-0000-7005-8000-000000000103', 'ORM', 'PT_EVAL', 'PT_CLEARANCE')
ON CONFLICT DO NOTHING;

-- 8. HIPAA: PHI read-access log (append-only, like audit_event).
CREATE TABLE phi_access_log (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL,
  actor_role varchar(48) NOT NULL,
  action varchar(48) NOT NULL,
  ward_id uuid,
  encounter_id uuid,
  patient_count integer NOT NULL DEFAULT 1 CHECK (patient_count >= 0),
  correlation_id varchar(128) NOT NULL,
  client_ip varchar(64)
);
CREATE INDEX phi_access_actor_idx ON phi_access_log (actor_id, occurred_at DESC);
CREATE INDEX phi_access_encounter_idx ON phi_access_log (encounter_id, occurred_at DESC);
CREATE TRIGGER phi_access_log_append_only BEFORE UPDATE OR DELETE ON phi_access_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON phi_access_log FROM dischargeloop_app;

-- 9. Identity integration with MedSync users: new functional roles, ward scope, lockout.
ALTER TYPE medsync.user_role ADD VALUE IF NOT EXISTS 'case_manager';
ALTER TYPE medsync.user_role ADD VALUE IF NOT EXISTS 'pharmacist';
ALTER TYPE medsync.user_role ADD VALUE IF NOT EXISTS 'transport';
ALTER TYPE medsync.user_role ADD VALUE IF NOT EXISTS 'housekeeping';
ALTER TYPE medsync.user_role ADD VALUE IF NOT EXISTS 'bed_manager';
ALTER TYPE medsync.user_role ADD VALUE IF NOT EXISTS 'admission';
ALTER TYPE medsync.user_role ADD VALUE IF NOT EXISTS 'billing';
ALTER TABLE medsync.app_users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE medsync.app_users ADD COLUMN IF NOT EXISTS locked_until timestamptz;

CREATE TABLE user_ward_scope (
  user_id uuid NOT NULL REFERENCES medsync.app_users(user_id) ON DELETE CASCADE,
  ward_id uuid NOT NULL REFERENCES ward(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ward_id)
);

-- 10. Fix 004: idempotency_request has no id column.
CREATE OR REPLACE FUNCTION cleanup_expired_idempotency_requests(batch_size integer DEFAULT 1000)
RETURNS integer AS $$
DECLARE deleted_count integer;
BEGIN
  WITH expired AS (
    SELECT actor_id, idempotency_key FROM idempotency_request WHERE expires_at < now() LIMIT batch_size
  )
  DELETE FROM idempotency_request r USING expired e
  WHERE r.actor_id = e.actor_id AND r.idempotency_key = e.idempotency_key;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 11. Command Center read model: live capacity per ward from the system of record.
CREATE VIEW ward_capacity_v AS
SELECT w.id AS ward_id, w.code, w.name, w.department_type,
       count(b.id) AS total_beds,
       count(b.id) FILTER (WHERE b.state = 'OCCUPIED') AS occupied,
       count(b.id) FILTER (WHERE b.state = 'AVAILABLE') AS available,
       count(b.id) FILTER (WHERE b.state = 'RESERVED') AS reserved,
       count(b.id) FILTER (WHERE b.state = 'CLEANING') AS cleaning,
       count(b.id) FILTER (WHERE b.state IN ('BLOCKED', 'MAINTENANCE')) AS out_of_service,
       (SELECT count(*) FROM discharge d JOIN encounter e ON e.id = d.encounter_id
         WHERE e.ward_id = w.id AND d.state IN ('INITIATED', 'MEDICALLY_CLEARED', 'TASKS_PENDING', 'READY_TO_DEPART')) AS discharges_in_progress,
       (SELECT count(*) FROM discharge d JOIN encounter e ON e.id = d.encounter_id
         WHERE e.ward_id = w.id AND d.state = 'READY_TO_DEPART') AS ready_to_depart
FROM ward w LEFT JOIN bed b ON b.ward_id = w.id
WHERE w.is_active
GROUP BY w.id;
