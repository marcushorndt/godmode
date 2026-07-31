/**
 * `buildExtension` — the record-level half of "Add another week".
 *
 * The core test (`src/core/patterns/percentageRamp.test.ts`) proves the *curve* leaves existing
 * sessions alone. This one proves the *records* do: that the builder returns only new slots,
 * never touches the ones it was handed, and refuses a plan it cannot account for rather than
 * appending onto a hole.
 */

import { describe, expect, it } from 'vitest';
import { buildChallenge, buildExtension, PlanExtensionError } from './records.js';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import type { Baseline } from '../core/types.js';
import type { ChallengeRecord, PlanSlotRecord } from './schema.js';

const baseline: Baseline = {
  value: 18,
  source: 'tested',
  recordedAt: '2026-05-29T08:00:00.000Z',
};

function reference(): { challenge: ChallengeRecord; slots: PlanSlotRecord[] } {
  return buildChallenge({ exerciseId: 'ex_1', params: pushupParams(18, 100), baseline });
}

describe('buildExtension', () => {
  it('appends one week of sessions and returns nothing else', () => {
    const { challenge, slots } = reference();
    const extension = buildExtension({ challenge, existingSlots: slots });

    expect(slots).toHaveLength(18);
    expect(extension.slots).toHaveLength(3);
    expect(extension.firstOrdinal).toBe(19);
    expect(extension.slots.map((s) => s.ordinal)).toEqual([19, 20, 21]);
    expect(extension.slots.map((s) => s.targetTotal)).toEqual([216, 227, 238]);
    expect(extension.slots.map((s) => [s.week, s.day])).toEqual([
      [7, 1],
      [7, 2],
      [7, 3],
    ]);
    for (const slot of extension.slots) {
      expect(slot.challengeId).toBe(challenge.id);
      expect(slot.status).toBe('available');
      expect(slot.supersedesId).toBeUndefined();
      expect(slot.patternMetrics?.['generationMax']).toBeGreaterThan(100);
    }
    // Fresh ids, so nothing can be mistaken for a slot that already exists.
    const existingIds = new Set(slots.map((s) => s.id));
    for (const slot of extension.slots) expect(existingIds.has(slot.id)).toBe(false);
  });

  it('leaves every existing slot record byte-identical', () => {
    const { challenge, slots } = reference();
    const before = structuredClone(slots);
    buildExtension({ challenge, existingSlots: slots });
    expect(slots).toEqual(before);
  });

  it('records the extension in patternParams and moves nothing else on the challenge', () => {
    const { challenge, slots } = reference();
    const extension = buildExtension({ challenge, existingSlots: slots });

    expect(extension.challenge.patternParams['extraSessions']).toBe(3);
    expect(extension.challenge.patternParams['extensionDamping']).toBe(0.5);
    // weeks is NOT bumped: it is the denominator of the base ramp's exponent.
    expect(extension.challenge.patternParams['weeks']).toBe(6);
    expect(extension.challenge.patternParams['baselineMax']).toBe(18);
    expect(extension.challenge.patternParams['goalMax']).toBe(100);
    expect({ ...extension.challenge, patternParams: {} }).toEqual({
      ...challenge,
      patternParams: {},
    });
  });

  it('continues a second time from where the first extension stopped', () => {
    const { challenge, slots } = reference();
    const first = buildExtension({ challenge, existingSlots: slots });
    const second = buildExtension({
      challenge: first.challenge,
      existingSlots: [...slots, ...first.slots],
    });

    expect(second.slots.map((s) => s.ordinal)).toEqual([22, 23, 24]);
    expect(second.slots.map((s) => s.targetTotal)).toEqual([250, 264, 278]);
    expect(second.challenge.patternParams['extraSessions']).toBe(6);
    expect(second.slots[0]!.targetTotal).toBeGreaterThan(first.slots[2]!.targetTotal);
  });

  it('appends an explicit number of sessions when asked', () => {
    const { challenge, slots } = reference();
    expect(buildExtension({ challenge, existingSlots: slots, sessions: 1 }).slots).toHaveLength(1);
    expect(buildExtension({ challenge, existingSlots: slots, sessions: 6 }).slots).toHaveLength(6);
  });

  /** The refusal, so the reason can be asserted rather than just the throw. */
  function refusal(run: () => unknown): PlanExtensionError {
    try {
      run();
    } catch (cause) {
      if (cause instanceof PlanExtensionError) return cause;
      throw cause;
    }
    throw new Error('expected a PlanExtensionError');
  }

  it('refuses a plan with a hole in it rather than appending past the gap', () => {
    const { challenge, slots } = reference();
    for (const existingSlots of [
      slots.filter((s) => s.ordinal !== 7),
      slots.slice(0, 17),
      [...slots, slots[0]!],
    ]) {
      // `inconsistent`, so the UI says so instead of quietly dropping the button.
      expect(refusal(() => buildExtension({ challenge, existingSlots })).reason).toBe(
        'inconsistent',
      );
    }
  });

  it('refuses an ended challenge, and one built by another pattern', () => {
    const { challenge, slots } = reference();
    // `unsupported`, not a fault: nothing is said, the button is simply absent.
    expect(
      refusal(() =>
        buildExtension({
          challenge: { ...challenge, status: 'ended', endReason: 'closed_manually' },
          existingSlots: slots,
        }),
      ).reason,
    ).toBe('unsupported');
    expect(
      refusal(() =>
        buildExtension({
          challenge: { ...challenge, patternId: 'some-future-pattern' },
          existingSlots: slots,
        }),
      ).reason,
    ).toBe('unsupported');
  });

  it('reads no workout — the extension is a function of the challenge alone', () => {
    const { challenge, slots } = reference();
    // Same inputs, twice, with nothing else available to consult: identical prescriptions.
    const a = buildExtension({ challenge, existingSlots: slots });
    const b = buildExtension({ challenge, existingSlots: slots });
    expect(a.slots.map((s) => s.targets)).toEqual(b.slots.map((s) => s.targets));
    expect(a.slots.map((s) => s.targetTotal)).toEqual(b.slots.map((s) => s.targetTotal));
  });
});
