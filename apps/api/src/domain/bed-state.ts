import { DomainError } from './domain-error';

export const BED_STATES = [
  'AVAILABLE',
  'RESERVED',
  'OCCUPIED',
  'CLEANING',
  'BLOCKED',
  'MAINTENANCE',
] as const;

export type BedState = (typeof BED_STATES)[number];

const LEGAL_TRANSITIONS: Readonly<Record<BedState, readonly BedState[]>> = {
  AVAILABLE: ['RESERVED', 'BLOCKED', 'MAINTENANCE'],
  RESERVED: ['AVAILABLE', 'OCCUPIED'],
  OCCUPIED: ['CLEANING', 'BLOCKED', 'MAINTENANCE'],
  CLEANING: ['AVAILABLE'],
  BLOCKED: ['AVAILABLE'],
  MAINTENANCE: ['AVAILABLE'],
};

// Clinical reversal states (bypass normal transitions via database trigger)
// Used for "2 PM Fever" scenario where discharge is cancelled and bed must remain OCCUPIED
export const CLINICAL_REVERSAL_BYPASS: ReadonlySet<BedState> = new Set(['OCCUPIED']);

export function assertBedTransition(from: BedState, to: BedState): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new DomainError('ILLEGAL_TRANSITION', `Bed cannot move from ${from} to ${to}`);
  }
}

export function canTransitionBed(from: BedState, to: BedState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

// Extended reason codes for clinical reversal and discharge workflow
export const BED_REASON_CODES = [
  'RESERVATION_REQUESTED',
  'RESERVATION_CANCELLED',
  'RESERVATION_EXPIRED',
  'ADMISSION_CONFIRMED',
  'CLINICAL_BLOCK',
  'CLINICAL_UNBLOCK',
  'MAINTENANCE_STARTED',
  'MAINTENANCE_COMPLETED',
  'DISCHARGE_CANCELLED_REVERSED',
] as const;

export type BedReasonCode = (typeof BED_REASON_CODES)[number];
