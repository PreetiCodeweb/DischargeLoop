-- Enum values added by 006 cannot be removed (PostgreSQL); they are harmless when unused.
-- Encounter-level tasks (no discharge) cannot be represented after rollback, so they are removed first.
DELETE FROM task WHERE discharge_id IS NULL;
ALTER TABLE task ALTER COLUMN discharge_id SET NOT NULL;
DROP INDEX IF EXISTS task_encounter_status_idx;
ALTER TABLE task DROP COLUMN IF EXISTS encounter_id;
ALTER TABLE encounter DROP COLUMN IF EXISTS last_adt_at;
ALTER TABLE encounter DROP COLUMN IF EXISTS medicare;
ALTER TABLE encounter DROP COLUMN IF EXISTS on_leave;
ALTER TABLE encounter DROP COLUMN IF EXISTS patient_class;
