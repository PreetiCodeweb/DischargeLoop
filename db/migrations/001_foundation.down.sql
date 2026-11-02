DROP TABLE IF EXISTS integration_quarantine, integration_link, processed_event, outbox,
  audit_event, cleaning, escalation_policy, task, discharge, bed_assignment,
  encounter, patient, bed, ward, hospital CASCADE;
DROP FUNCTION IF EXISTS reject_audit_mutation();
DROP TYPE IF EXISTS cleaning_status, task_status, discharge_state, encounter_status,
  assignment_state, assignment_kind, bed_state;
