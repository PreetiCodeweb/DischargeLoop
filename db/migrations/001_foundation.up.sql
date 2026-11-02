CREATE TYPE bed_state AS ENUM ('AVAILABLE', 'RESERVED', 'OCCUPIED', 'CLEANING', 'BLOCKED', 'MAINTENANCE');
CREATE TYPE assignment_kind AS ENUM ('RESERVATION', 'OCCUPANCY');
CREATE TYPE assignment_state AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED', 'ENDED');
CREATE TYPE encounter_status AS ENUM ('EXPECTED', 'ADMITTED', 'DEPARTED', 'CANCELLED');
CREATE TYPE discharge_state AS ENUM ('INITIATED', 'MEDICALLY_CLEARED', 'TASKS_PENDING', 'READY_TO_DEPART', 'DEPARTED', 'CANCELLED');
CREATE TYPE task_status AS ENUM ('OPEN', 'CLAIMED', 'DONE', 'CANCELLED');
CREATE TYPE cleaning_status AS ENUM ('OPEN', 'ACCEPTED', 'VERIFIED');

CREATE TABLE hospital (
  id uuid PRIMARY KEY,
  name varchar(160) NOT NULL,
  timezone varchar(80) NOT NULL,
  is_primary boolean NOT NULL DEFAULT true UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ward (
  id uuid PRIMARY KEY,
  hospital_id uuid NOT NULL REFERENCES hospital(id) ON DELETE RESTRICT,
  name varchar(120) NOT NULL,
  code varchar(32) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hospital_id, code)
);

CREATE TABLE bed (
  id uuid PRIMARY KEY,
  ward_id uuid NOT NULL REFERENCES ward(id) ON DELETE RESTRICT,
  label varchar(40) NOT NULL,
  state bed_state NOT NULL,
  state_reason_code varchar(48) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ward_id, label)
);
CREATE INDEX bed_board_idx ON bed (ward_id, state, label);

CREATE TABLE patient (
  id uuid PRIMARY KEY,
  hospital_id uuid NOT NULL REFERENCES hospital(id) ON DELETE RESTRICT,
  his_patient_id varchar(128) NOT NULL,
  display_name varchar(180) NOT NULL,
  date_of_birth date,
  sex varchar(24),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hospital_id, his_patient_id)
);

CREATE TABLE encounter (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  ward_id uuid NOT NULL REFERENCES ward(id) ON DELETE RESTRICT,
  bed_id uuid REFERENCES bed(id) ON DELETE RESTRICT,
  status encounter_status NOT NULL,
  his_encounter_id varchar(128) NOT NULL,
  admitted_at timestamptz,
  departed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (his_encounter_id),
  CHECK (departed_at IS NULL OR admitted_at IS NOT NULL),
  CHECK (departed_at IS NULL OR departed_at >= admitted_at)
);
CREATE INDEX encounter_ward_status_idx ON encounter (ward_id, status);

CREATE TABLE bed_assignment (
  id uuid PRIMARY KEY,
  bed_id uuid NOT NULL REFERENCES bed(id) ON DELETE RESTRICT,
  encounter_id uuid REFERENCES encounter(id) ON DELETE RESTRICT,
  kind assignment_kind NOT NULL,
  state assignment_state NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_by uuid,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'RESERVATION' AND expires_at IS NOT NULL) OR kind = 'OCCUPANCY'),
  CHECK ((state = 'ACTIVE' AND ended_at IS NULL) OR (state <> 'ACTIVE' AND ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_assignment_per_bed
  ON bed_assignment (bed_id) WHERE state = 'ACTIVE';
CREATE INDEX bed_assignment_expiry_idx
  ON bed_assignment (expires_at) WHERE state = 'ACTIVE' AND kind = 'RESERVATION';

CREATE TABLE discharge (
  id uuid PRIMARY KEY,
  encounter_id uuid NOT NULL UNIQUE REFERENCES encounter(id) ON DELETE RESTRICT,
  state discharge_state NOT NULL,
  initiated_by uuid NOT NULL,
  initiated_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  ready_at timestamptz,
  departed_at timestamptz,
  cancelled_reason_code varchar(48),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state <> 'CANCELLED') OR cancelled_reason_code IS NOT NULL)
);

CREATE TABLE task (
  id uuid PRIMARY KEY,
  discharge_id uuid NOT NULL REFERENCES discharge(id) ON DELETE RESTRICT,
  type varchar(48) NOT NULL,
  title varchar(160) NOT NULL,
  owner_role varchar(48) NOT NULL,
  owner_user_id uuid,
  status task_status NOT NULL DEFAULT 'OPEN',
  priority smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  blocking boolean NOT NULL DEFAULT true,
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('DONE', 'CANCELLED') AND completed_at IS NOT NULL) OR status IN ('OPEN', 'CLAIMED'))
);
CREATE INDEX task_owner_due_idx ON task (owner_user_id, status, due_at);
CREATE INDEX task_team_due_idx ON task (owner_role, status, due_at);

CREATE TABLE escalation_policy (
  id uuid PRIMARY KEY,
  task_type varchar(48) NOT NULL,
  level integer NOT NULL CHECK (level > 0),
  after_minutes integer NOT NULL CHECK (after_minutes >= 0),
  notify_role varchar(48) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_type, level)
);

CREATE TABLE cleaning (
  id uuid PRIMARY KEY,
  bed_id uuid NOT NULL REFERENCES bed(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  accepted_by uuid,
  accepted_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  notes varchar(280),
  status cleaning_status NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'OPEN' AND accepted_at IS NULL AND verified_at IS NULL)
      OR (status = 'ACCEPTED' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND verified_at IS NULL)
      OR (status = 'VERIFIED' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (verified_by IS NULL OR verified_by <> accepted_by)
);
CREATE UNIQUE INDEX one_open_cleaning_per_bed
  ON cleaning (bed_id) WHERE status <> 'VERIFIED';

CREATE TABLE audit_event (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL,
  actor_role varchar(48) NOT NULL,
  action varchar(80) NOT NULL,
  entity_type varchar(48) NOT NULL,
  entity_id uuid NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  reason_code varchar(48) NOT NULL,
  correlation_id varchar(128) NOT NULL,
  request_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_time_idx ON audit_event (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_actor_time_idx ON audit_event (actor_id, occurred_at DESC);

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END;
$$;
CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM dischargeloop_app;
GRANT SELECT, INSERT ON audit_event TO dischargeloop_app;

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  aggregate_type varchar(48) NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type varchar(80) NOT NULL,
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_unpublished_idx ON outbox (occurred_at) WHERE published_at IS NULL;

CREATE TABLE processed_event (
  consumer varchar(80) NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE integration_link (
  id uuid PRIMARY KEY,
  source_system varchar(80) NOT NULL,
  external_id varchar(160) NOT NULL,
  entity_type varchar(48) NOT NULL,
  entity_id uuid NOT NULL,
  last_seen_at timestamptz,
  source_precedence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, external_id, entity_type)
);

CREATE TABLE integration_quarantine (
  id uuid PRIMARY KEY,
  source_system varchar(80) NOT NULL,
  raw_payload jsonb NOT NULL,
  reason varchar(80) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolved_at IS NULL AND resolved_by IS NULL) OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);

ALTER DEFAULT PRIVILEGES FOR ROLE dischargeloop_migrator IN SCHEMA dischargeloop
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dischargeloop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dischargeloop_migrator IN SCHEMA dischargeloop
  GRANT USAGE, SELECT ON SEQUENCES TO dischargeloop_app;
