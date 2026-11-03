-- Migration 003: Discharge Enhancement Architecture
-- Implements the "2 PM Fever" clinical reversal, external post-acute coordination,
-- HL7 v2 event handling, and pre-flight referral scrubbing

-- 1. Extend discharge_state enum to include CANCELLED_REVERSED
-- Recreate the enum with the new value (PostgreSQL limitation: can't add values in transactions that use them)
CREATE TYPE discharge_state_new AS ENUM (
  'INITIATED',
  'MEDICALLY_CLEARED',
  'TASKS_PENDING',
  'READY_TO_DEPART',
  'DEPARTED',
  'CANCELLED',
  'CANCELLED_REVERSED'
);

-- Convert the discharge.state column to the new enum type
-- First drop the CHECK constraint that uses enum comparison
ALTER TABLE discharge DROP CONSTRAINT IF EXISTS discharge_check;

ALTER TABLE discharge ALTER COLUMN state TYPE discharge_state_new USING state::text::discharge_state_new;

-- Drop the old enum type
DROP TYPE discharge_state;

-- Rename the new enum to the original name
ALTER TYPE discharge_state_new RENAME TO discharge_state;

-- 2. Extend reason_code enum for new clinical scenarios
-- Recreate the enum with new values
CREATE TYPE reason_code_new AS ENUM (
  'CREATED',
  'RESERVATION_REQUESTED',
  'RESERVATION_CANCELLED',
  'RESERVATION_EXPIRED',
  'ADMISSION_CONFIRMED',
  'CLINICAL_BLOCK',
  'CLINICAL_UNBLOCK',
  'MAINTENANCE_STARTED',
  'MAINTENANCE_COMPLETED',
  'DISCHARGE_CANCELLED_REVERSED',
  'DISCHARGE_PENDING',
  'TASK_AUTO_COMPLETED',
  'REFERRAL_SCRUBBED',
  'EXTERNAL_PARTNER_ACCEPTED',
  'EXTERNAL_PARTNER_DECLINED'
);

-- Convert columns to new type
ALTER TABLE bed ALTER COLUMN state_reason_code TYPE reason_code_new USING state_reason_code::text::reason_code_new;
ALTER TABLE audit_event ALTER COLUMN reason_code TYPE reason_code_new USING reason_code::text::reason_code_new;

-- Drop old type
DROP TYPE reason_code;

-- Rename new type
ALTER TYPE reason_code_new RENAME TO reason_code;

-- 3. Add HL7 v2 event types for integration tracking
CREATE TYPE hl7_event_type AS ENUM (
  'ADT_A01', -- Admit
  'ADT_A02', -- Transfer
  'ADT_A03', -- Discharge
  'ADT_A08', -- Update Patient
  'ADT_A11', -- Cancel Admit
  'ADT_A12', -- Cancel Transfer
  'ADT_A13', -- Cancel Discharge
  'ADT_A16', -- Pending Discharge
  'ADT_A25', -- Cancel Pending Discharge
  'ORM',     -- Order
  'ORU',     -- Observation/Result
  'RDE'      -- Pharmacy Dispense
);

-- 4. External Partner Integration (SNF/Rehab/Home Health)
CREATE TABLE external_partner (
  id uuid PRIMARY KEY,
  hospital_id uuid NOT NULL REFERENCES hospital(id) ON DELETE RESTRICT,
  partner_name varchar(180) NOT NULL,
  partner_type varchar(48) NOT NULL, -- 'SNF', 'REHAB', 'HOME_HEALTH', 'COMMUNITY_CARE'
  contact_email varchar(160),
  contact_phone varchar(48),
  magic_link_enabled boolean NOT NULL DEFAULT true,
  magic_link_ttl_seconds integer NOT NULL DEFAULT 3600,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hospital_id, partner_name)
);
CREATE INDEX idx_external_partner_hospital ON external_partner(hospital_id, is_active);

-- 5. Referral Management for External Post-Acute Handoff
CREATE TABLE referral (
  id uuid PRIMARY KEY,
  discharge_id uuid NOT NULL REFERENCES discharge(id) ON DELETE RESTRICT,
  encounter_id uuid NOT NULL REFERENCES encounter(id) ON DELETE RESTRICT,
  external_partner_id uuid REFERENCES external_partner(id) ON DELETE SET NULL,
  status varchar(48) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'SENT', 'ACCEPTED', 'DECLINED', 'CANCELLED'
  sent_at timestamptz,
  responded_at timestamptz,
  declined_reason text,
  magic_link_token varchar(128),
  magic_link_expires_at timestamptz,
  one_page_summary_url varchar(512),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_referral_discharge ON referral(discharge_id);
CREATE INDEX idx_referral_partner ON referral(external_partner_id, status);
CREATE INDEX idx_referral_token ON referral(magic_link_token) WHERE magic_link_token IS NOT NULL;

-- 6. Pre-Flight Referral Scrubber (Validation Before Sending)
CREATE TABLE referral_scrubber (
  id uuid PRIMARY KEY,
  referral_id uuid NOT NULL REFERENCES referral(id) ON DELETE CASCADE,
  scrub_type varchar(48) NOT NULL, -- 'HIGH_COST_MED', 'MISSING_PT_NOTES', 'INSURANCE_AUTH', 'INCOMPLETE_LABS'
  severity varchar(24) NOT NULL, -- 'BLOCKING', 'WARNING', 'INFO'
  description text NOT NULL,
  is_resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_referral_scrubber_referral ON referral_scrubber(referral_id, is_resolved);

-- 7. HL7 v2 Event Tracking
CREATE TABLE hl7_event_log (
  id uuid PRIMARY KEY,
  source_system varchar(80) NOT NULL,
  event_type hl7_event_type NOT NULL,
  message_control_id varchar(48),
  patient_id uuid REFERENCES patient(id) ON DELETE SET NULL,
  encounter_id uuid REFERENCES encounter(id) ON DELETE SET NULL,
  discharge_id uuid REFERENCES discharge(id) ON DELETE SET NULL,
  task_id uuid REFERENCES task(id) ON DELETE SET NULL,
  raw_payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_status varchar(24) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSED', 'FAILED', 'QUARANTINED'
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_hl7_event_encounter ON hl7_event_log(encounter_id, event_type, created_at DESC);
CREATE INDEX idx_hl7_event_status ON hl7_event_log(processing_status, created_at);
CREATE INDEX idx_hl7_event_discharge ON hl7_event_log(discharge_id, event_type);

-- 8. Add SMART on FHIR launch context tracking
CREATE TABLE fhir_launch_context (
  id uuid PRIMARY KEY,
  encounter_id uuid NOT NULL REFERENCES encounter(id) ON DELETE RESTRICT,
  launch_id varchar(128) NOT NULL,
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  scope varchar(512),
  launched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (launch_id)
);
CREATE INDEX idx_fhir_launch_encounter ON fhir_launch_context(encounter_id);
CREATE INDEX idx_fhir_launch_expiry ON fhir_launch_context(expires_at) WHERE expires_at IS NOT NULL;

-- 9. Add task auto-completion trigger function
CREATE OR REPLACE FUNCTION auto_complete_task_from_hl7()
RETURNS TRIGGER AS $$
DECLARE
  task_to_complete record;
BEGIN
  -- Only process successfully processed events
  IF NEW.processing_status <> 'PROCESSED' THEN
    RETURN NEW;
  END IF;

  -- ORM (Order) - Auto-complete pharmacy tasks
  IF NEW.event_type = 'ORM' AND NEW.task_id IS NOT NULL THEN
    UPDATE task
    SET status = 'DONE',
        completed_at = NOW(),
        updated_at = NOW(),
        version = version + 1
    WHERE id = NEW.task_id AND status IN ('OPEN', 'CLAIMED');
  END IF;

  -- ORU (Lab Result) - Auto-complete lab tasks
  IF NEW.event_type = 'ORU' AND NEW.task_id IS NOT NULL THEN
    UPDATE task
    SET status = 'DONE',
        completed_at = NOW(),
        updated_at = NOW(),
        version = version + 1
    WHERE id = NEW.task_id AND status IN ('OPEN', 'CLAIMED');
  END IF;

  -- RDE (Pharmacy Dispense) - Auto-complete pharmacy dispense tasks
  IF NEW.event_type = 'RDE' AND NEW.task_id IS NOT NULL THEN
    UPDATE task
    SET status = 'DONE',
        completed_at = NOW(),
        updated_at = NOW(),
        version = version + 1
    WHERE id = NEW.task_id AND status IN ('OPEN', 'CLAIMED');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_hl7_task_auto_complete
  AFTER UPDATE ON hl7_event_log
  FOR EACH ROW
  WHEN (NEW.processing_status = 'PROCESSED' AND OLD.processing_status <> 'PROCESSED')
  EXECUTE FUNCTION auto_complete_task_from_hl7();

-- 10. Enhanced discharge reversal trigger ("2 PM Fever" scenario)
-- Note: This is created after enum conversions to avoid type comparison issues
CREATE OR REPLACE FUNCTION manage_discharge_reversal()
RETURNS TRIGGER AS $$
DECLARE
  assoc_bed_id uuid;
  assoc_encounter_id uuid;
  is_active_hold_cancelled BOOLEAN := FALSE;
BEGIN
  -- Only act on discharge state changes
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- Evaluate Optimistic Concurrency Checks
  IF NEW.version_id <> OLD.version_id + 1 THEN
    RAISE EXCEPTION 'Version mismatch error. Record was altered by another process.';
  END IF;

  -- Extract encounter and bed information
  SELECT encounter_id INTO assoc_encounter_id FROM encounter WHERE id = NEW.encounter_id;
  SELECT bed_id INTO assoc_bed_id FROM encounter WHERE id = NEW.encounter_id;

  -- SCENARIO: Edge case rollback when discharge is marked 'CANCELLED_REVERSED' (e.g., 2 PM clinical fever)
  IF NEW.state::text = 'CANCELLED_REVERSED' AND OLD.state::text <> 'CANCELLED_REVERSED' THEN
    -- Force associate bed state to remain locked back to 'OCCUPIED'
    IF assoc_bed_id IS NOT NULL THEN
      UPDATE bed
      SET state = 'OCCUPIED',
          state_reason_code = 'DISCHARGE_CANCELLED_REVERSED',
          version = version + 1,
          updated_at = NOW()
      WHERE id = assoc_bed_id;
    END IF;

    -- Cancel any active reservations on this bed (they were for the incoming patient)
    UPDATE bed_assignment
    SET state = 'CANCELLED',
        ended_at = NOW(),
        updated_at = NOW()
    WHERE bed_id = assoc_bed_id
      AND kind = 'RESERVATION'
      AND state = 'ACTIVE';

    is_active_hold_cancelled := TRUE;

    -- Automate Task Termination
    UPDATE task
    SET status = 'CANCELLED',
        completed_at = NOW(),
        updated_at = NOW()
    WHERE discharge_id = NEW.id AND status IN ('OPEN', 'CLAIMED');

    -- Fire Domain Outbox Alert for Reversal
    INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload, headers, occurred_at)
    VALUES (
      uuid_generate_v4(),
      'discharge',
      NEW.id,
      'DischargeReversed',
      jsonb_build_object(
        'discharge_id', NEW.id,
        'encounter_id', NEW.encounter_id,
        'bed_id', assoc_bed_id,
        'reason', NEW.cancelled_reason_code,
        'cancelled_at', NOW()
      ),
      jsonb_build_object('correlation_id', 'discharge-reversal'),
      NOW()
    );

    -- Write audit event for reversal
    INSERT INTO audit_event (
      id, actor_id, actor_role, action, entity_type, entity_id,
      before_state, after_state, reason_code, correlation_id, request_id, occurred_at
    )
    VALUES (
      uuid_generate_v4(),
      'SYSTEM',
      'SYSTEM',
      'discharge.reversed',
      'discharge',
      NEW.id,
      jsonb_build_object('state', OLD.state::text, 'version', OLD.version_id),
      jsonb_build_object('state', NEW.state::text, 'version', NEW.version_id),
      'DISCHARGE_CANCELLED_REVERSED',
      'discharge-reversal',
      'discharge-reversal',
      NOW()
    );

  ELSIF NEW.state::text = 'DEPARTED' AND OLD.state::text <> 'DEPARTED' THEN
    -- Safely mark patient discharged in underlying encounters record
    UPDATE encounter
    SET status = 'DEPARTED',
        departed_at = NOW(),
        version = version + 1,
        updated_at = NOW()
    WHERE id = NEW.encounter_id;

    -- Initiate the 'TURN' loop. Move state to CLEANING, force audit check bounds, hold availability.
    IF assoc_bed_id IS NOT NULL THEN
      UPDATE bed
      SET state = 'CLEANING',
          state_reason_code = 'ADMISSION_CONFIRMED',
          version = version + 1,
          updated_at = NOW()
      WHERE id = assoc_bed_id;
    END IF;

    -- Fire Domain Outbox Departure
    INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload, headers, occurred_at)
    VALUES (
      uuid_generate_v4(),
      'discharge',
      NEW.id,
      'PatientDeparted',
      jsonb_build_object(
        'discharge_id', NEW.id,
        'encounter_id', NEW.encounter_id,
        'bed_id', assoc_bed_id,
        'departed_at', NOW()
      ),
      jsonb_build_object('correlation_id', 'patient-departed'),
      NOW()
    );

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS trigger_discharge_state ON discharge;

-- Create the new enhanced trigger
CREATE TRIGGER trigger_discharge_state
  AFTER UPDATE ON discharge
  FOR EACH ROW
  EXECUTE FUNCTION manage_discharge_reversal();

-- 11. Add constraint to ensure reversal reason is provided
ALTER TABLE discharge
  ADD CONSTRAINT check_reversal_reason
  CHECK ((state <> 'CANCELLED_REVERSED') OR (state = 'CANCELLED_REVERSED' AND cancelled_reason_code IS NOT NULL));

-- 12. Add index for efficient reversal queries
CREATE INDEX idx_discharge_reversal ON discharge(state, cancelled_reason_code) WHERE state = 'CANCELLED_REVERSED';
