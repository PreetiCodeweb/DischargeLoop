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

export function assertBedTransition(from: BedState, to: BedState): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new DomainError('ILLEGAL_TRANSITION', `Bed cannot move from ${from} to ${to}`);
  }
}

export function canTransitionBed(from: BedState, to: BedState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}
