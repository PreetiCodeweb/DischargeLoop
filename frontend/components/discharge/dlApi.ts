import { apiRequest, ApiError } from '../../apiClient';

export type DischargeState =
  | 'NOT_STARTED' | 'INITIATED' | 'MEDICALLY_CLEARED' | 'TASKS_PENDING' | 'READY_TO_DEPART'
  | 'DEPARTED' | 'CANCELLED' | 'CANCELLED_REVERSED';
export type TransitionTarget = Exclude<DischargeState, 'NOT_STARTED'>;
export type BlockerSide = 'INTERNAL' | 'EXTERNAL';

export interface Ward {
  ward_id: string; code: string; name: string; department_type: string | null; total_beds: number; occupied: number;
  available: number; reserved: number; cleaning: number; out_of_service: number; discharges_in_progress: number; ready_to_depart: number;
}
export interface BlockerSummary { id: string; category: string; side: BlockerSide; description: string; external_party: string | null; opened_at: string }
export interface TaskSummary { id: string; title: string; owner: string; due_at: string }
export interface WorklistItem {
  encounter_id: string; his_encounter_id: string; admitted_at: string | null; ward_id: string; ward_code: string;
  patient_name: string; mrn: string; date_of_birth: string | null; bed_id: string | null; bed_label: string | null;
  discharge_id: string | null; state: DischargeState; version: number | null; expected_discharge_at: string | null;
  cleared_at: string | null; ready_at: string | null; reversal_count: number | null; reversal_reason: string | null; source: string | null;
  top_blocker: BlockerSummary | null; open_blockers: number; external_blockers: number; next_task: TaskSummary | null;
  open_tasks: number; overdue_tasks: number; hours_since_medically_cleared: number | null;
  patient_class: string; on_leave: boolean; medicare: boolean;
}
export interface FeedHealth { configured: boolean; last_message_at: string | null; age_seconds: number | null; stale_after_seconds: number; stale: boolean }
export interface Worklist {
  summary: { patients: number; in_progress: number; ready_to_depart: number; overdue_tasks: number; external_blockers: number };
  items: WorklistItem[];
}
export interface Task {
  id: string; discharge_id?: string; type: string; title: string; owner: string; owner_user_id: string | null;
  status: 'OPEN' | 'CLAIMED' | 'DONE' | 'CANCELLED'; priority: number; blocking: boolean; due_at: string; completed_at?: string | null;
  escalation_level: number; source: string; overdue: boolean; ward_code?: string; bed_label?: string | null; version: number;
}
export interface Blocker {
  id: string; category: string; side: BlockerSide; status: 'OPEN' | 'RESOLVED' | 'CANCELLED'; description: string;
  external_party: string | null; owner_role: string; opened_at: string; resolved_at: string | null; resolution_note: string | null;
}
export interface TimelineEntry { occurred_at: string; actor_role: string; action: string; reason_code: string }
export interface DischargeDetail {
  id: string; state: TransitionTarget; version: number; expected_discharge_at: string | null; initiated_at: string;
  cleared_at: string | null; ready_at: string | null; departed_at: string | null; reversal_reason: string | null;
  reversal_count: number; source: string; encounter_id: string; ward_code: string; bed_label: string | null;
  patient_name: string; mrn: string; tasks: Task[]; blockers: Blocker[]; timeline: TimelineEntry[];
}
export interface BedRow {
  id: string; label: string; state: string; reason: string; ward_id: string; ward_code: string;
  encounter_id: string | null; discharge_state: string | null; reserved_until: string | null;
}
export interface CleaningJob { id: string; status: 'OPEN' | 'ACCEPTED'; requested_at: string; accepted_by: string | null; bed_label: string; ward_code: string }
export interface Notification {
  id: string; kind: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; body: string;
  entity_type: string | null; entity_id: string | null; created_at: string; read_at: string | null; ward_code: string | null;
}
export interface IntegrationStatus { feed: FeedHealth; events: { event_type: string; processing_status: string; n: number; last_seen: string }[]; open_quarantine: number }
export interface Metrics {
  ready_delay: { departed: number; avg_hours_cleared_to_departed: number | null };
  blockers_by_category: { category: string; side: BlockerSide; total: number; open: number; avg_hours_open: number | null }[];
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const correlation = (): HeadersInit => ({ 'X-Correlation-Id': crypto.randomUUID() });

export const dl = {
  meta: () => apiRequest<{ blocker_categories: string[] }>('/api/v1/dl/meta'),
  wards: () => apiRequest<Ward[]>('/api/v1/dl/wards'),
  worklist: (wardId?: string) => apiRequest<Worklist>(`/api/v1/dl/worklist${wardId ? `?ward_id=${encodeURIComponent(wardId)}` : ''}`),
  discharge: (id: string) => apiRequest<DischargeDetail>(`/api/v1/dl/discharges/${encodeURIComponent(id)}`),
  initiate: (encounterId: string, expectedDischargeAt?: string) =>
    apiRequest<{ id: string }>('/api/v1/dl/discharges', { ...json({ encounter_id: encounterId, expected_discharge_at: expectedDischargeAt || null }), headers: correlation() }),
  transition: (id: string, target: TransitionTarget, version: number, reason?: string) =>
    apiRequest<{ state: string }>(`/api/v1/dl/discharges/${encodeURIComponent(id)}/transition`, { ...json({ target_state: target, expected_version: version, reason: reason || null }), headers: correlation() }),
  setExpectedDischarge: (id: string, expected: string | null) =>
    apiRequest(`/api/v1/dl/discharges/${encodeURIComponent(id)}/expected-discharge`, { method: 'PATCH', body: JSON.stringify({ expected_discharge_at: expected }), headers: correlation() }),
  addTask: (id: string, task: { type: string; title: string; owner_role: string; due_in_minutes: number; blocking: boolean }) =>
    apiRequest(`/api/v1/dl/discharges/${encodeURIComponent(id)}/tasks`, { ...json(task), headers: correlation() }),
  addBlocker: (id: string, blocker: { category: string; description: string; side?: BlockerSide; external_party?: string; due_in_minutes: number }) =>
    apiRequest(`/api/v1/dl/discharges/${encodeURIComponent(id)}/blockers`, { ...json(blocker), headers: correlation() }),
  closeBlocker: (id: string, action: 'resolve' | 'cancel', note?: string) =>
    apiRequest(`/api/v1/dl/blockers/${encodeURIComponent(id)}/${action}`, { ...json({ note: note || null }), headers: correlation() }),
  tasks: (mine: boolean) => apiRequest<Task[]>(`/api/v1/dl/tasks?mine=${mine}`),
  taskAction: (id: string, action: 'claim' | 'complete' | 'cancel') =>
    apiRequest(`/api/v1/dl/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: correlation() }),
  beds: () => apiRequest<BedRow[]>('/api/v1/dl/beds'),
  reserve: (bedId: string, ttlMinutes: number) => apiRequest(`/api/v1/dl/beds/${encodeURIComponent(bedId)}/reserve`, { ...json({ ttl_minutes: ttlMinutes }), headers: correlation() }),
  release: (bedId: string) => apiRequest(`/api/v1/dl/beds/${encodeURIComponent(bedId)}/release`, { method: 'POST', headers: correlation() }),
  cleaning: () => apiRequest<CleaningJob[]>('/api/v1/dl/cleaning'),
  cleaningAction: (id: string, action: 'accept' | 'verify') =>
    apiRequest(`/api/v1/dl/cleaning/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: correlation() }),
  notifications: (unread: boolean) => apiRequest<Notification[]>(`/api/v1/dl/notifications?unread=${unread}`),
  markRead: (id: string) => apiRequest<void>(`/api/v1/dl/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  metrics: () => apiRequest<Metrics>('/api/v1/dl/metrics'),
  integration: () => apiRequest<IntegrationStatus>('/api/v1/dl/integration/status'),
  feedHealth: () => apiRequest<FeedHealth>('/api/v1/dl/feed-health'),
  runEscalations: () => apiRequest<{ escalated: number }>('/api/v1/dl/escalations/run', { method: 'POST' }),
};

/** Client-side navigation compatible with the shell router in app/App.tsx (it listens to popstate). */
export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export const STATE_LABEL: Record<DischargeState, string> = {
  NOT_STARTED: 'Not started', INITIATED: 'Initiated', MEDICALLY_CLEARED: 'Medically cleared', TASKS_PENDING: 'Tasks pending',
  READY_TO_DEPART: 'Ready to depart', DEPARTED: 'Departed', CANCELLED: 'Cancelled', CANCELLED_REVERSED: 'Reversed (clinical)',
};

/** Mirrors the server rule: only the owning role (or the person who claimed it) may claim/complete a task. */
export const canWork = (task: Pick<Task, 'owner' | 'owner_user_id'>, role: string, userId: string) =>
  task.owner.split('@')[0] === role || task.owner_user_id === userId;

const CATEGORY_LABEL: Record<string, string> = {
  MEDICATION_RECONCILIATION: 'Medication reconciliation', LABS: 'Labs / results pending', PT_OT_CLEARANCE: 'PT/OT clearance',
  DISCHARGE_SUMMARY: 'Discharge summary', PRIOR_AUTH_INSURANCE: 'Prior authorization / insurance', TRANSPORT: 'Transport',
  DME_EQUIPMENT: 'Durable medical equipment (DME)', POST_ACUTE_PLACEMENT: 'Post-acute placement (SNF/rehab/home health)',
  FAMILY_CAREGIVER: 'Family / caregiver', OTHER: 'Other',
};
export const categoryLabel = (category: string) => CATEGORY_LABEL[category] ?? humanize(category);

export const humanize = (value: string) => value.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function formatWhen(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relativeDue(value: string): string {
  const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return minutes >= 0 ? `due in ${minutes} min` : `${-minutes} min overdue`;
  const hours = Math.round(minutes / 60);
  return hours >= 0 ? `due in ${hours} h` : `${-hours} h overdue`;
}
