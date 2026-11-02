import { describe, expect, it } from 'vitest';
import { assertBedTransition, canTransitionBed, type BedState } from './bed-state';

describe('bed state machine', () => {
  const legal: Array<[BedState, BedState]> = [
    ['AVAILABLE', 'RESERVED'],
    ['AVAILABLE', 'BLOCKED'],
    ['AVAILABLE', 'MAINTENANCE'],
    ['RESERVED', 'AVAILABLE'],
    ['RESERVED', 'OCCUPIED'],
    ['OCCUPIED', 'CLEANING'],
    ['OCCUPIED', 'BLOCKED'],
    ['OCCUPIED', 'MAINTENANCE'],
    ['CLEANING', 'AVAILABLE'],
    ['BLOCKED', 'AVAILABLE'],
    ['MAINTENANCE', 'AVAILABLE'],
  ];

  it.each(legal)('allows %s → %s', (from, to) => {
    expect(canTransitionBed(from, to)).toBe(true);
    expect(() => assertBedTransition(from, to)).not.toThrow();
  });

  it('rejects every transition not listed in the bed lifecycle', () => {
    const states: BedState[] = ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'CLEANING', 'BLOCKED', 'MAINTENANCE'];
    for (const from of states) {
      for (const to of states) {
        if (canTransitionBed(from, to)) continue;
        expect(() => assertBedTransition(from, to)).toThrowError(
          expect.objectContaining({ code: 'ILLEGAL_TRANSITION' }),
        );
      }
    }
  });
});
