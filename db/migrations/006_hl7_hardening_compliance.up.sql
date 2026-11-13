-- Migration 006: real-world ADT feed hardening + encounter-level compliance tasks.

-- 1. ADT events seen on production Epic feeds beyond the MVP set.
ALTER TYPE hl7_event_type ADD VALUE IF NOT EXISTS 'ADT_A04';  -- register (ED/outpatient)
ALTER TYPE hl7_event_type ADD VALUE IF NOT EXISTS 'ADT_A05';  -- pre-admit
ALTER TYPE hl7_event_type ADD VALUE IF NOT EXISTS 'ADT_A06';  -- outpatient/observation -> inpatient
ALTER TYPE hl7_event_type ADD VALUE IF NOT EXISTS 'ADT_A07';  -- inpatient -> outpatient/observation
ALTER TYPE hl7_event_type ADD VALUE IF NOT EXISTS 'ADT_A17';  -- bed swap (two PID/PV1 pairs)
ALTER TYPE hl7_event_type ADD VALUE IF NOT EXISTS 'ADT_A21';  -- leave of absence
ALTER TYPE hl7_event_type ADD VALUE IF NOT EXISTS 'ADT_A22';  -- return from leave of absence
ALTER TYPE hl7_event_type ADD VALUE IF NOT EXISTS 'ADT_A34';  -- merge patient (id only, legacy)
ALTER TYPE hl7_event_type ADD VALUE IF NOT EXISTS 'ADT_A40';  -- merge patient (identifier list)

ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'ENCOUNTER_SWAPPED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'ENCOUNTER_LEAVE_STARTED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'ENCOUNTER_LEAVE_ENDED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'ENCOUNTER_CLASS_CHANGED';
ALTER TYPE reason_code ADD VALUE IF NOT EXISTS 'PATIENT_MERGED';

-- 2. Encounter facts needed for correct behavior.
ALTER TABLE encounter ADD COLUMN patient_class varchar(8) NOT NULL DEFAULT 'I';  -- PV1-2 (I inpatient, O outpatient/obs, E emergency)
ALTER TABLE encounter ADD COLUMN on_leave boolean NOT NULL DEFAULT false;        -- A21/A22: bed stays held
ALTER TABLE encounter ADD COLUMN medicare boolean NOT NULL DEFAULT false;        -- from IN1; drives the Important Message from Medicare
-- Out-of-order guard: the event time (EVN-2/MSH-7) of the latest ADT applied to this encounter.
ALTER TABLE encounter ADD COLUMN last_adt_at timestamptz;

-- 3. Tasks belong to the encounter; a discharge is optional (e.g. the initial IM is due at admission).
ALTER TABLE task ADD COLUMN encounter_id uuid REFERENCES encounter(id) ON DELETE RESTRICT;
UPDATE task t SET encounter_id = d.encounter_id FROM discharge d WHERE d.id = t.discharge_id;
ALTER TABLE task ALTER COLUMN encounter_id SET NOT NULL;
ALTER TABLE task ALTER COLUMN discharge_id DROP NOT NULL;
CREATE INDEX task_encounter_status_idx ON task (encounter_id, status);
