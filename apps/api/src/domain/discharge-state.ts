import { DomainError } from './domain-error';

export const DISCHARGE_STATES = [
  'INITIATED',
  'MEDICALLY_CLEARED',
  'TASKS_PENDING',
  'READY_TO_DEPART',
  'DEPARTED',
  'CANCELLED',
  'CANCELLED_REVERSED',
] as const;

export type DischargeState = (typeof DISCHARGE_STATES)[number];

const LEGAL_TRANSITIONS: Readonly<Record<DischargeState, readonly DischargeState[]>> = {
  INITIATED: ['MEDICALLY_CLEARED', 'CANCELLED'],
  MEDICALLY_CLEARED: ['TASKS_PENDING', 'CANCELLED'],
  TASKS_PENDING: ['READY_TO_DEPART', 'CANCELLED'],
  READY_TO_DEPART: ['DEPARTED', 'CANCELLED'],
  DEPARTED: [], // Terminal state
  CANCELLED: [], // Terminal state
  CANCELLED_REVERSED: ['INITIATED', 'MEDICALLY_CLEARED', 'TASKS_PENDING', 'READY_TO_DEPART'], // Can restart workflow after reversal
};

export function assertDischargeTransition(from: DischargeState, to: DischargeState): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new DomainError('ILLEGAL_DISCHARGE_TRANSITION', `Discharge cannot move from ${from} to ${to}`);
  }
}

export function canTransitionDischarge(from: DischargeState, to: DischargeState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

// Clinical reversal states - special bypass for "2 PM Fever" scenario
export const CLINICAL_REVERSAL_STATES: ReadonlySet<DischargeState> = new Set(['CANCELLED_REVERSED']);

export const DISCHARGE_REASON_CODES = [
  'DISCHARGE_CANCELLED_REVERSED',
  'DISCHARGE_PENDING',
  'TASK_AUTO_COMPLETED',
  'REFERRAL_SCRUBBED',
  'EXTERNAL_PARTNER_ACCEPTED',
  'EXTERNAL_PARTNER_DECLINED',
] as const;

export type DischargeReasonCode = (typeof DISCHARGE_REASON_CODES)[number];
