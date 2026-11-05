export interface Persona {
  key: string;
  name: string;
  roles: string[];
  id: string;
}

export interface Ward {
  id: string;
  name: string;
  code: string;
  bed_count: number;
  available: number;
  reserved: number;
  occupied: number;
  cleaning: number;
  unavailable: number;
}

export interface Bed {
  id: string;
  ward_id: string;
  ward_name: string;
  label: string;
  state: BedState;
  state_reason_code: string;
  version: number;
  updated_at: string;
}

export type BedState = 'AVAILABLE' | 'RESERVED' | 'OCCUPIED' | 'CLEANING' | 'BLOCKED' | 'MAINTENANCE';

export interface Encounter {
  id: string;
  status: string;
  ward_id: string;
  ward_name: string;
  bed_id: string | null;
  bed_label: string | null;
  patient_id: string;
  patient_name: string;
  date_of_birth: string | null;
  sex: string | null;
  discharge_id: string | null;
  discharge_state: string | null;
  admitted_at: string | null;
  updated_at: string;
}

export type DischargeState =
  | 'INITIATED'
  | 'MEDICALLY_CLEARED'
  | 'TASKS_PENDING'
  | 'READY_TO_DEPART'
  | 'DEPARTED'
  | 'CANCELLED'
  | 'CANCELLED_REVERSED';

export interface Discharge {
  id: string;
  state: DischargeState;
  initiated_at: string;
  cleared_at: string | null;
  ready_at: string | null;
  departed_at: string | null;
  version: number;
  encounter_id: string;
  ward_id: string;
  ward_name: string;
  bed_id: string | null;
  bed_label: string | null;
  patient_name: string;
  open_tasks: number;
  blocking_tasks: number;
}

export interface Task {
  id: string;
  type: string;
  title: string;
  owner_role: string;
  owner_user_id: string | null;
  status: 'OPEN' | 'CLAIMED' | 'DONE' | 'CANCELLED';
  priority: number;
  blocking: boolean;
  due_at: string;
  completed_at: string | null;
  version: number;
  patient_name?: string;
  ward_name?: string;
}

export interface DischargeDetail {
  discharge: Discharge;
  tasks: Task[];
}

export interface CleaningJob {
  id: string;
  bed_id: string;
  bed_label: string;
  ward_name: string;
  status: 'OPEN' | 'ACCEPTED' | 'VERIFIED';
  requested_at: string;
  accepted_at: string | null;
  verified_at: string | null;
  notes: string | null;
}

export interface AuditEvent {
  id: string;
  occurred_at: string;
  actor_id: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}

export interface Analytics {
  beds: Record<string, number>;
  totalBeds: number;
  occupancyRate: number;
  dischargesByState: Record<string, number>;
  openTasks: number;
  overdueTasks: number;
  expiringReservations: Array<{ id: string; bed_label: string; ward_name: string; expires_at: string }>;
  averageLengthOfStayHours: number;
  departedLast30Days: number;
}
