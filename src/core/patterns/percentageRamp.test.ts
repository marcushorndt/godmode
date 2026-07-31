import { describe, expect, it } from 'vitest';
import {
  EXTENSION_DAMPING,
  PUSHUP_5SET_TEMPLATE,
  baseSessionCount,
  createPercentageRampPattern,
  extendParams,
  extensionSlots,
  extendedGenerationMaxAt,
  generationMaxAt,
  percentageRampPattern,
  pushupParams,
  targetsForMax,
  totalSessionCount,
  type PercentageRampParams,
} from './percentageRamp.js';
import { materialize } from '../contracts.js';
import {
  DEFAULT_VOLUME_REST_PARAMS,
  restSecondsForVolume,
  fixedRestPolicy,
} from '../policies/rest.js';

const shape = {
  coefficients: [...PUSHUP_5SET_TEMPLATE.coefficients],
  roles: [...PUSHUP_5SET_TEMPLATE.roles],
  amrapIndices: [...PUSHUP_5SET_TEMPLATE.amrapIndices],
};

const repsOf = (targets: { reps: number }[]) => targets.map((t) => t.reps);
const referencePlan = () => materialize(percentageRampPattern, pushupParams(18, 100));

describe('GEN-02/GEN-03 — the two VERIFIED reference cards', () => {
  it('reproduces the baseline card at M=18 exactly (7·8·7·6·9+, total 37)', () => {
    const targets = targetsForMax(18, shape);
    expect(repsOf(targets)).toEqual([7, 8, 7, 6, 9]);
    expect(targets.reduce((s, t) => s + t.reps, 0)).toBe(37);
    expect(targets[4]!.isAmrap).toBe(true);
  });

  it('reproduces the goal card at M=100 exactly (37·47·37·33·51+, total 205)', () => {
    const targets = targetsForMax(100, shape);
    expect(repsOf(targets)).toEqual([37, 47, 37, 33, 51]);
    expect(targets.reduce((s, t) => s + t.reps, 0)).toBe(205);
    expect(targets[4]!.isAmrap).toBe(true);
  });

  it('places both verified cards at the first and last slot of the reference plan', () => {
    const slots = referencePlan();
    expect(slots).toHaveLength(18);

    expect(repsOf(slots[0]!.targets)).toEqual([7, 8, 7, 6, 9]);
    expect(slots[0]).toMatchObject({ targetTotal: 37, week: 1, day: 1 });

    expect(repsOf(slots[17]!.targets)).toEqual([37, 47, 37, 33, 51]);
    expect(slots[17]).toMatchObject({ targetTotal: 205, week: 6, day: 3 });
  });

  it('coefficients sum to 2.05, explaining why goal 100 yields 205 reps', () => {
    expect(shape.coefficients.reduce((s, c) => s + c, 0)).toBeCloseTo(2.05, 10);
  });
});

describe('GEN-05 — non-strict set ordering (percentage-ramp 5-set shape only)', () => {
  // This invariant belongs to THIS pattern's 5-set shape, not to all generated plans.
  // Strict ordering is provably unsatisfiable — see the regression guard below.
  it('holds set5 >= set2 >= set1 == set3 >= set4 for every integer max in 1..200', () => {
    const violations: string[] = [];
    for (let max = 1; max <= 200; max += 1) {
      const [s1, s2, s3, s4, s5] = repsOf(targetsForMax(max, shape)) as [
        number, number, number, number, number,
      ];
      if (!(s5 >= s2 && s2 >= s1 && s1 === s3 && s3 >= s4)) {
        violations.push(`M=${max} -> ${s1},${s2},${s3},${s4},${s5}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('documents that STRICT ordering would fail at ordinary maxima', () => {
    // Regression guard: if someone "repairs" rounding to force strictness, these break.
    expect(repsOf(targetsForMax(14, shape))).toEqual([5, 7, 5, 5, 7]); // set5 > set2 fails
    expect(repsOf(targetsForMax(20, shape))).toEqual([7, 9, 7, 7, 10]); // set3 > set4 fails
    expect(repsOf(targetsForMax(21, shape))).toEqual([8, 10, 8, 7, 11]); // first strict max
  });

  it('would have failed a strict assertion on slot 2 of the reference plan itself', () => {
    const slot2 = referencePlan()[1]!;
    expect(repsOf(slot2.targets)).toEqual([7, 9, 7, 7, 10]);
    const [, , s3, s4] = repsOf(slot2.targets) as [number, number, number, number, number];
    expect(s3 > s4).toBe(false);
    expect(s3 >= s4).toBe(true);
  });

  it('never prescribes zero reps, even at max=1', () => {
    for (let max = 1; max <= 200; max += 1) {
      for (const t of targetsForMax(max, shape)) expect(t.reps).toBeGreaterThanOrEqual(1);
    }
  });

  it('marks AMRAP by metadata, never by ordering', () => {
    for (let max = 1; max <= 200; max += 1) {
      const amraps = targetsForMax(max, shape).filter((t) => t.isAmrap);
      expect(amraps).toHaveLength(1);
      expect(amraps[0]!.index).toBe(5);
    }
  });
});

describe('AMRAP cardinality — zero, one, or several are all valid', () => {
  it('supports no AMRAP set at all', () => {
    const targets = targetsForMax(50, { ...shape, amrapIndices: [] });
    expect(targets.filter((t) => t.isAmrap)).toHaveLength(0);
  });

  it('supports several AMRAP sets', () => {
    const targets = targetsForMax(50, { ...shape, amrapIndices: [1, 4] });
    expect(targets.filter((t) => t.isAmrap).map((t) => t.index)).toEqual([2, 5]);
  });

  it('rejects duplicate or out-of-range amrap indices', () => {
    expect(() => targetsForMax(50, { ...shape, amrapIndices: [4, 4] })).not.toThrow();
    const params = pushupParams(18, 100);
    expect(() =>
      percentageRampPattern.initialState({ ...params, amrapIndices: [4, 4] }),
    ).toThrow(RangeError);
    expect(() =>
      percentageRampPattern.initialState({ ...params, amrapIndices: [9] }),
    ).toThrow(RangeError);
  });
});

describe('generation max ramp', () => {
  it('starts at baseline and ends at goal', () => {
    expect(generationMaxAt(1, 18, 18, 100)).toBeCloseTo(18, 10);
    expect(generationMaxAt(18, 18, 18, 100)).toBeCloseTo(100, 10);
  });

  it('grows ~10.6% per session for the reference challenge', () => {
    expect(generationMaxAt(6, 18, 18, 100) / generationMaxAt(5, 18, 18, 100)).toBeCloseTo(
      1.1061,
      4,
    );
  });

  it('is flat when goal equals baseline (fixed-load, not "maintenance")', () => {
    const slots = materialize(percentageRampPattern, pushupParams(40, 40, 4, 3));
    expect(slots).toHaveLength(12);
    const first = repsOf(slots[0]!.targets);
    for (const slot of slots) {
      expect(repsOf(slot.targets)).toEqual(first);
      expect(slot.targetTotal).toBe(slots[0]!.targetTotal);
      expect(slot.restSeconds).toBe(slots[0]!.restSeconds);
    }
  });

  it('rejects nonsense inputs rather than producing NaN plans', () => {
    expect(() => generationMaxAt(1, 18, 0, 100)).toThrow(RangeError);
    expect(() => generationMaxAt(1, 18, 18, 0)).toThrow(RangeError);
    expect(() => generationMaxAt(0, 18, 18, 100)).toThrow(RangeError);
    expect(() => generationMaxAt(19, 18, 18, 100)).toThrow(RangeError);
  });
});

describe('honest scorecard against the reference CSV (PLAN.md §1.3)', () => {
  // Asserts what the model ACTUALLY does, misses included. If the curve is ever
  // "improved", these must be updated deliberately rather than drifting silently.
  const totalAt = (ordinal: number) => referencePlan()[ordinal - 1]!.targetTotal;

  it('matches observed totals exactly at slots 1, 12, 13, 16, 18', () => {
    expect([totalAt(1), totalAt(12), totalAt(13), totalAt(16), totalAt(18)]).toEqual([
      37, 112, 123, 167, 205,
    ]);
  });

  it('misses observed totals at slots 14, 15, 17 (observed 138, 156, 187)', () => {
    expect([totalAt(14), totalAt(15), totalAt(17)]).toEqual([137, 151, 184]);
  });

  it('runs above observed totals on the early slots', () => {
    expect(totalAt(2)).toBeGreaterThan(39);
    expect(totalAt(5)).toBeGreaterThan(49);
  });

  it('produces a monotonically non-decreasing volume ramp', () => {
    const slots = referencePlan();
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.targetTotal).toBeGreaterThanOrEqual(slots[i - 1]!.targetTotal);
    }
  });
});

describe('GEN-08 — rest as a policy', () => {
  it('hits the two assumed endpoints of the reference curve', () => {
    expect(restSecondsForVolume(37, DEFAULT_VOLUME_REST_PARAMS)).toBe(30);
    expect(restSecondsForVolume(205, DEFAULT_VOLUME_REST_PARAMS)).toBe(150);
  });

  it('clamps to 30..180 and rounds to 5s across a wide volume range', () => {
    for (let v = 1; v <= 400; v += 1) {
      const rest = restSecondsForVolume(v, DEFAULT_VOLUME_REST_PARAMS);
      expect(rest % 5).toBe(0);
      expect(rest).toBeGreaterThanOrEqual(30);
      expect(rest).toBeLessThanOrEqual(180);
    }
  });

  it('prescribes no rest after the final set', () => {
    const slots = referencePlan();
    const last = slots[0]!.targets.at(-1)!;
    expect(last.restAfterSeconds).toBe(0);
    expect(slots[0]!.targets[0]!.restAfterSeconds).toBe(slots[0]!.restSeconds);
  });

  it('is swappable — a fixed-rest policy overrides the curve entirely', () => {
    const pattern = createPercentageRampPattern(
      fixedRestPolicy as never,
      { restSeconds: 90 } as never,
    );
    const slots = materialize(pattern, pushupParams(18, 100));
    for (const slot of slots) expect(slot.restSeconds).toBe(90);
  });
});

describe('incremental generation', () => {
  it('next() returns null once the plan is exhausted', () => {
    const params = pushupParams(18, 100);
    let state = percentageRampPattern.initialState(params);
    let produced = 0;
    for (;;) {
      const r = percentageRampPattern.next({ params, state, history: [] });
      if (r === null) break;
      produced += 1;
      state = r.nextState;
      expect(r.slot.ordinal).toBe(produced);
    }
    expect(produced).toBe(18);
  });

  it('records an auditable decision snapshot per slot', () => {
    const params = pushupParams(18, 100);
    const state = percentageRampPattern.initialState(params);
    const r = percentageRampPattern.next({ params, state, history: [] })!;
    expect(r.decision).toMatchObject({
      patternId: 'percentage-ramp',
      patternVersion: 1,
      ordinal: 1,
      sessions: 18,
      restPolicyId: 'volume-derived-rest',
    });
  });

  it('reports a planned session count for a finite pattern', () => {
    expect(percentageRampPattern.plannedSessionCount(pushupParams(18, 100))).toBe(18);
  });
});

describe('week/day layout and validation', () => {
  it('lays sessions out across weeks for 4 days/week', () => {
    const slots = materialize(percentageRampPattern, pushupParams(18, 100, 3, 4));
    expect(slots).toHaveLength(12);
    expect(slots[0]).toMatchObject({ week: 1, day: 1 });
    expect(slots[3]).toMatchObject({ week: 1, day: 4 });
    expect(slots[4]).toMatchObject({ week: 2, day: 1 });
    expect(slots[11]).toMatchObject({ week: 3, day: 4 });
  });

  it('supports a variable number of sets with no code change', () => {
    const params: PercentageRampParams = {
      ...pushupParams(18, 100),
      coefficients: [0.37, 0.47, 0.33, 0.51],
      roles: ['medium', 'big', 'small', 'amrap'],
      amrapIndices: [3],
    };
    const slots = materialize(percentageRampPattern, params);
    expect(slots[0]!.targets).toHaveLength(4);
    expect(slots[0]!.targets[3]!.isAmrap).toBe(true);
  });

  it('rejects mismatched coefficients and roles', () => {
    const params = { ...pushupParams(18, 100), roles: ['medium', 'big'] as never };
    expect(() => percentageRampPattern.initialState(params)).toThrow(RangeError);
  });

  it('targetTotal always equals the sum of its targets', () => {
    for (const slot of referencePlan()) {
      expect(slot.targetTotal).toBe(slot.targets.reduce((s, t) => s + t.reps, 0));
    }
  });
});

describe('extending a plan that has run out', () => {
  const base = () => pushupParams(18, 100);

  it('appends the owner\'s real next three sessions: 216, 227, 238', () => {
    // baseline 18, goal 100, N = 18, coefficients [0.37, 0.47, 0.37, 0.33, 0.51], round-half-up.
    // Damped ratio r' = r^0.5 where r = (100/18)^(1/17) = 1.10613..., so r' = 1.05173...
    // and M(18 + k) = 100 * r'^k.
    const added = extensionSlots(base(), 3);
    expect(added).toHaveLength(3);

    expect(added.map((s) => s.ordinal)).toEqual([19, 20, 21]);
    expect(added.map((s) => s.targetTotal)).toEqual([216, 227, 238]);
    expect(repsOf(added[0]!.targets)).toEqual([39, 49, 39, 35, 54]);
    expect(repsOf(added[1]!.targets)).toEqual([41, 52, 41, 37, 56]);
    expect(repsOf(added[2]!.targets)).toEqual([43, 55, 43, 38, 59]);
  });

  it('starts exactly where the base ramp ended, and climbs at half its rate', () => {
    const r = generationMaxAt(18, 18, 18, 100) / generationMaxAt(17, 18, 18, 100);
    const m19 = extendedGenerationMaxAt(1, 18, 18, 100);
    const m20 = extendedGenerationMaxAt(2, 18, 18, 100);

    // Continuous at the join: the first appended session is one damped step above goalMax,
    // not a jump and not a repeat.
    expect(m19 / 100).toBeCloseTo(Math.sqrt(r), 12);
    expect(m20 / m19).toBeCloseTo(Math.sqrt(r), 12);
    // Two damped steps land exactly on one undamped one — the definition of half in log space.
    expect(m20).toBeCloseTo(100 * r, 10);

    expect(r).toBeCloseTo(1.1061, 4);
    expect(Math.sqrt(r)).toBeCloseTo(1.0517, 4);
    expect(EXTENSION_DAMPING).toBe(0.5);
  });

  it('leaves every existing slot byte-identical and adds only new ordinals', () => {
    const before = materialize(percentageRampPattern, base());
    const snapshot = structuredClone(before);
    const after = materialize(percentageRampPattern, extendParams(base(), 3));

    expect(after).toHaveLength(21);
    for (let i = 0; i < snapshot.length; i += 1) {
      // Deep equality on the whole slot: targets, per-set rest, totals, week/day, metrics.
      expect(after[i]).toEqual(snapshot[i]);
    }
    expect(after.slice(0, 18).map((s) => s.ordinal)).toEqual(before.map((s) => s.ordinal));
    expect(after.slice(18).map((s) => s.ordinal)).toEqual([19, 20, 21]);
  });

  it('rewrites every session if N is raised instead — the trap this design avoids', () => {
    const before = materialize(percentageRampPattern, base());
    const naive = materialize(percentageRampPattern, { ...base(), weeks: 7 });

    expect(naive).toHaveLength(21);
    // Session 2 of a plan already performed would come back with a different prescription.
    expect(naive[1]!.targetTotal).not.toBe(before[1]!.targetTotal);
    const changed = before.filter((slot, i) => naive[i]!.targetTotal !== slot.targetTotal);
    expect(changed.length).toBeGreaterThan(10);
  });

  it('gives the appended sessions correct week/day coordinates', () => {
    const added = extensionSlots(base(), 3);
    expect(added.map((s) => [s.week, s.day])).toEqual([
      [7, 1],
      [7, 2],
      [7, 3],
    ]);

    // Four days a week: session 13 of a 3-week plan is week 4 day 1.
    const fourDay = extensionSlots(pushupParams(18, 100, 3, 4), 4);
    expect(fourDay.map((s) => [s.ordinal, s.week, s.day])).toEqual([
      [13, 4, 1],
      [14, 4, 2],
      [15, 4, 3],
      [16, 4, 4],
    ]);
  });

  it('carries generationMax in patternMetrics, as every other slot does', () => {
    for (const slot of extensionSlots(base(), 3)) {
      expect(slot.patternMetrics?.['generationMax']).toBeGreaterThan(100);
    }
    expect(extensionSlots(base(), 1)[0]!.patternMetrics).toEqual({
      generationMax: extendedGenerationMaxAt(1, 18, 18, 100),
    });
  });

  it('continues from where the last extension stopped, not from the goal again', () => {
    const once = extendParams(base(), 3);
    const twice = extendParams(once, 3);

    expect(totalSessionCount(once)).toBe(21);
    expect(totalSessionCount(twice)).toBe(24);
    expect(baseSessionCount(twice)).toBe(18);

    // Two extensions of three == one extension of six. If k restarted at 1 the second block
    // would repeat 216/227/238 instead of continuing past them.
    expect(materialize(percentageRampPattern, twice)).toEqual(
      materialize(percentageRampPattern, extendParams(base(), 6)),
    );
    const second = extensionSlots(once, 3);
    expect(second.map((s) => s.ordinal)).toEqual([22, 23, 24]);
    expect(second.map((s) => s.targetTotal)).toEqual([250, 264, 278]);
    expect(second[0]!.targetTotal).toBeGreaterThan(238);
  });

  it('is reproducible from patternParams alone', () => {
    const params = extendParams(base(), 3);
    // Round-tripped through JSON, exactly as `challenges.pattern_params` stores it.
    const stored = JSON.parse(JSON.stringify(params)) as PercentageRampParams;
    expect(stored.extraSessions).toBe(3);
    expect(stored.extensionDamping).toBe(EXTENSION_DAMPING);
    expect(materialize(percentageRampPattern, stored)).toEqual(
      materialize(percentageRampPattern, params),
    );
  });

  it('holds steady rather than climbing when the plan was flat', () => {
    const flat = pushupParams(40, 40, 4, 3);
    const added = extensionSlots(flat, 3);
    const original = materialize(percentageRampPattern, flat);
    for (const slot of added) {
      expect(slot.targetTotal).toBe(original[0]!.targetTotal);
    }
  });

  it('changes nothing for a challenge that has never been extended', () => {
    const untouched = materialize(percentageRampPattern, base());
    expect(untouched).toHaveLength(18);
    expect(percentageRampPattern.plannedSessionCount(base())).toBe(18);
    expect(totalSessionCount(base())).toBe(18);
    // An explicit zero must be the same thing as an absent field.
    expect(materialize(percentageRampPattern, { ...base(), extraSessions: 0 })).toEqual(untouched);
  });

  it('rejects nonsense rather than producing a NaN plan', () => {
    expect(() =>
      percentageRampPattern.initialState({ ...base(), extraSessions: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      percentageRampPattern.initialState({ ...base(), extraSessions: 1.5 }),
    ).toThrow(RangeError);
    expect(() =>
      percentageRampPattern.initialState({ ...base(), extensionDamping: Number.NaN }),
    ).toThrow(RangeError);
    expect(() => extendParams(base(), 0)).toThrow(RangeError);
    expect(() => extendParams(base(), 2.5)).toThrow(RangeError);
    expect(() => extendedGenerationMaxAt(0, 18, 18, 100)).toThrow(RangeError);
  });
});
