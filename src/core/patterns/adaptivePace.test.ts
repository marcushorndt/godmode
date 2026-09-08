import { describe, expect, it } from 'vitest';
import { materialize } from '../contracts.js';
import {
  percentageRampPattern,
  pushupParams,
  type PercentageRampParams,
} from './percentageRamp.js';
import {
  COMFORT_MARGIN,
  OBSERVATION_WINDOW,
  STEP_MAX,
  STEP_MIN,
  cappedSum,
  forecastBlock,
  isFlat,
  maxAtUnits,
  observeSession,
  projectUnits,
  rampRatio,
  seedAdaptiveState,
  targetsAtUnits,
  totalAtUnits,
  unitsForMax,
  unitsForTotal,
  type AdaptivePaceState,
  type SessionObservation,
} from './adaptivePace.js';

const base = (): PercentageRampParams => pushupParams(18, 100);

/** The fixed plan's session totals, 1-indexed by ordinal. */
const fixedTotals = (params = base()): number[] =>
  materialize(percentageRampPattern, params).map((slot) => slot.targetTotal);

/** What the prescribed (non-AMRAP) sets ask for at a position. */
const cappedTargetAt = (params: PercentageRampParams, units: number): number =>
  cappedSum(targetsAtUnits(params, units));

/** An athlete who does exactly the prescribed sets, first time. */
/** An athlete who does exactly the prescribed sets, first time, at the state's next session. */
const exactly = (params: PercentageRampParams, state: AdaptivePaceState): SessionObservation => ({
  ordinal: state.throughOrdinal + 1,
  cappedActual: cappedTargetAt(params, state.units),
  cappedTarget: cappedTargetAt(params, state.units),
  attempts: 1,
  passed: true,
});

describe('progress units are a faithful change of variable', () => {
  it('places session n of the fixed plan at position n - 1', () => {
    const params = base();
    const totals = fixedTotals(params);
    for (let ordinal = 1; ordinal <= totals.length; ordinal += 1) {
      expect(totalAtUnits(params, ordinal - 1)).toBe(totals[ordinal - 1]);
    }
  });

  it('round-trips a max through the unit scale', () => {
    const params = base();
    expect(unitsForMax(params, params.baselineMax)).toBeCloseTo(0, 10);
    expect(unitsForMax(params, params.goalMax)).toBeCloseTo(17, 10);
    expect(maxAtUnits(params, 17)).toBeCloseTo(100, 10);
    expect(unitsForTotal(params, 205)).toBeCloseTo(17, 1);
  });

  it('refuses a plan with no scale rather than dividing by log(1)', () => {
    const flat = pushupParams(40, 40, 4, 3);
    expect(isFlat(flat)).toBe(true);
    expect(() => unitsForMax(flat, 40)).toThrow(RangeError);
    expect(() => seedAdaptiveState(flat, 1)).toThrow(RangeError);
    expect(isFlat(base())).toBe(false);
    expect(rampRatio(base())).toBeCloseTo(1.10613, 4);
  });

  it('counts only the sets that are a fixed prescription', () => {
    const params = base();
    const targets = targetsAtUnits(params, 17);
    expect(targets.map((t) => t.reps)).toEqual([37, 47, 37, 33, 51]);
    // 51 is the AMRAP set and is excluded.
    expect(cappedSum(targets)).toBe(154);
  });
});

describe('INVARIANT: an athlete exactly on the curve gets the fixed plan, rep for rep', () => {
  it('reproduces every session of the reference plan', () => {
    const params = base();
    const totals = fixedTotals(params);
    let state = seedAdaptiveState(params, 1);
    const produced: number[] = [];

    for (let ordinal = 1; ordinal <= totals.length; ordinal += 1) {
      produced.push(totalAtUnits(params, state.units));
      state = observeSession(params, state, exactly(params, state));
    }

    expect(produced).toEqual(totals);
    expect(state.step).toBeCloseTo(1, 10);
  });

  it('does not accelerate on a bare pass, because meeting +10.6% proves nothing spare', () => {
    const params = base();
    let state = seedAdaptiveState(params, 1);
    for (let i = 0; i < 8; i += 1) state = observeSession(params, state, exactly(params, state));
    expect(state.step).toBeCloseTo(1, 10);
  });
});

describe('INVARIANT: a prescription never goes down', () => {
  it('holds position through a run of failures instead of retreating', () => {
    const params = base();
    let state = seedAdaptiveState(params, 10);
    const held = totalAtUnits(params, state.units);

    for (let i = 0; i < 5; i += 1) {
      state = observeSession(params, state, {
        ordinal: state.throughOrdinal + 1,
        cappedActual: Math.round(cappedTargetAt(params, state.units) * 0.7),
        cappedTarget: cappedTargetAt(params, state.units),
        attempts: i + 1,
        passed: false,
      });
      expect(totalAtUnits(params, state.units)).toBe(held);
    }
  });

  it('never emits a target below the previous one, on a badly erratic athlete', () => {
    const params = base();
    let state = seedAdaptiveState(params, 5);
    const swings = [1.4, 0.5, 1.1, 0.4, 0.95, 1.6, 0.3, 1.0, 0.6, 1.2, 0.2, 1.8];
    let previous = 0;

    for (const swing of swings) {
      const target = totalAtUnits(params, state.units);
      expect(target).toBeGreaterThanOrEqual(previous);
      previous = target;
      const capped = cappedTargetAt(params, state.units);
      const did = Math.round(capped * swing);
      state = observeSession(params, state, {
        ordinal: state.throughOrdinal + 1,
        cappedActual: did,
        cappedTarget: capped,
        attempts: 1,
        passed: swing >= 1,
      });
    }
  });
});

describe('INVARIANT: switching to adaptive never makes the next session harder', () => {
  it('starts exactly where the fixed plan stands, whatever the history says', () => {
    const params = base();
    const totals = fixedTotals(params);

    for (let ordinal = 1; ordinal <= totals.length; ordinal += 1) {
      // Someone who has been smashing it: three sessions at 150% of the prescribed work.
      const history: SessionObservation[] = [1, 2, 3].map((n) => ({
        ordinal: n,
        cappedActual: 300,
        cappedTarget: 200,
        attempts: 1,
        passed: true,
      }));
      const state = seedAdaptiveState(params, ordinal, history);
      expect(state.step).toBeLessThanOrEqual(1);
      expect(totalAtUnits(params, state.units)).toBe(totals[ordinal - 1]);
    }
  });
});

describe('the controller reads struggle without winding itself up', () => {
  it('eases the step when a session takes several attempts', () => {
    const params = base();
    let state = seedAdaptiveState(params, 8);
    state = observeSession(params, state, { ...exactly(params, state), attempts: 4 });
    expect(state.step).toBeLessThan(1);
  });

  it('eases when the prescribed sets themselves are costing too much, even on a pass', () => {
    const params = base();
    let state = seedAdaptiveState(params, 8);
    for (let i = 0; i < OBSERVATION_WINDOW; i += 1) {
      const capped = cappedTargetAt(params, state.units);
      state = observeSession(params, state, {
        ordinal: state.throughOrdinal + 1,
        cappedActual: Math.round(capped * 0.93),
        cappedTarget: capped,
        attempts: 1,
        passed: true, // he made the total up on the open set
      });
    }
    expect(state.step).toBeLessThan(1);
  });

  it('accelerates only on a comfortable margin', () => {
    const params = base();
    let tight = seedAdaptiveState(params, 8);
    let comfy = seedAdaptiveState(params, 8);

    for (let i = 0; i < OBSERVATION_WINDOW; i += 1) {
      tight = observeSession(params, tight, exactly(params, tight));
      const capped = cappedTargetAt(params, comfy.units);
      comfy = observeSession(params, comfy, {
        ordinal: comfy.throughOrdinal + 1,
        cappedActual: Math.round(capped * (COMFORT_MARGIN + 0.05)),
        cappedTarget: capped,
        attempts: 1,
        passed: true,
      });
    }
    expect(tight.step).toBeCloseTo(1, 10);
    expect(comfy.step).toBeGreaterThan(1);
  });

  it('keeps the step inside its bounds however extreme the run', () => {
    const params = base();
    let state = seedAdaptiveState(params, 6);
    for (let i = 0; i < 40; i += 1) {
      state = observeSession(params, state, {
        ordinal: state.throughOrdinal + 1,
        cappedActual: 1,
        cappedTarget: cappedTargetAt(params, state.units),
        attempts: 3,
        passed: false,
      });
      expect(state.step).toBeGreaterThanOrEqual(STEP_MIN);
    }
    for (let i = 0; i < 60; i += 1) {
      const capped = cappedTargetAt(params, state.units);
      state = observeSession(params, state, {
        ordinal: state.throughOrdinal + 1,
        cappedActual: capped * 5,
        cappedTarget: capped,
        attempts: 1,
        passed: true,
      });
      expect(state.step).toBeLessThanOrEqual(STEP_MAX);
    }
  });

  it('remembers only the last few sessions', () => {
    const params = base();
    let state = seedAdaptiveState(params, 4);
    for (let i = 0; i < 10; i += 1) {
      state = observeSession(params, state, exactly(params, state));
      expect(state.recent.length).toBeLessThanOrEqual(OBSERVATION_WINDOW);
    }
  });
});

describe('the forecast says where the block lands, not where the goal is', () => {
  it('projects the remaining sessions at the current step', () => {
    const state: AdaptivePaceState = { units: 9, step: 0.5, recent: [1], throughOrdinal: 0 };
    expect(projectUnits(state, 4)).toEqual([9, 9.5, 10, 10.5]);
  });

  it('reports a lower finish for a slower athlete, and how far the goal has moved', () => {
    const params = base();
    const slow = forecastBlock(params, { units: 9, step: 0.4, recent: [0.95], throughOrdinal: 0 }, 9);
    const onPace = forecastBlock(params, { units: 9, step: 1.0, recent: [1], throughOrdinal: 0 }, 9);

    expect(onPace.finalTotal).toBe(205);
    expect(slow.finalTotal).toBeLessThan(onPace.finalTotal);
    expect(slow.sessionsToGoal).toBeGreaterThan(onPace.sessionsToGoal!);
  });

  it('offers no sessions-to-goal once the goal is behind you', () => {
    const params = base();
    const past = forecastBlock(params, { units: 18, step: 0.5, recent: [1], throughOrdinal: 0 }, 3);
    expect(past.sessionsToGoal).toBeUndefined();
    expect(past.finalTotal).toBeGreaterThan(205);
  });
});

/**
 * The real thing.
 *
 * A colleague's export covers twelve attempts at this challenge between 2018 and 2026. None
 * finished. Every one died in week four or five, because he improves at 6 to 7% per session and
 * the fixed curve compounds at 10.6. These are his 2026 sessions, in the order he trained them.
 *
 * The test does NOT claim he would have passed more of them. His numbers were produced under the
 * fixed plan, and what he would have done if asked for less is not in the data. It pins the thing
 * the data can show: how far the prescription reaches beyond the athlete.
 */
describe('a real eight-year history of failing this challenge', () => {
  /** sets 1-5 as performed; the first four are the prescribed ones. */
  const performed: number[][] = [
    [6, 8, 6, 6, 9],
    [7, 8, 7, 6, 9],
    [7, 9, 7, 6, 10],
    [8, 10, 8, 7, 11],
    [9, 11, 9, 8, 12],
    [10, 12, 10, 9, 14],
    [11, 14, 11, 10, 14],
    [11, 14, 11, 10, 15],
    [12, 16, 12, 11, 17],
    [14, 18, 14, 12, 20],
    [16, 20, 16, 14, 22],
    [18, 23, 18, 16, 0], // all four prescribed sets exact, nothing on the open set
    [18, 20, 17, 13, 17],
    [18, 17, 16, 13, 14],
    [18, 18, 23, 18, 25],
    [20, 22, 13, 18, 14],
  ];
  const cappedOf = (sets: number[]): number => sets[0]! + sets[1]! + sets[2]! + sets[3]!;
  const totalOf = (sets: number[]): number => sets.reduce((a, b) => a + b, 0);

  function replayFixed(): { worstOverreach: number; nextAsk: number } {
    const params = base();
    const totals = fixedTotals(params);
    let ordinal = 1;
    let worst = 0;
    for (const sets of performed) {
      const target = totals[ordinal - 1]!;
      worst = Math.max(worst, target - totalOf(sets));
      if (totalOf(sets) >= target) ordinal += 1;
    }
    return { worstOverreach: worst, nextAsk: totals[ordinal - 1]! };
  }

  function replayAdaptive(): { worstOverreach: number; nextAsk: number; step: number } {
    const params = base();
    let state = seedAdaptiveState(params, 1);
    let worst = 0;
    let attempts = 1;
    for (const sets of performed) {
      const target = totalAtUnits(params, state.units);
      worst = Math.max(worst, target - totalOf(sets));
      const passed = totalOf(sets) >= target;
      state = observeSession(params, state, {
        ordinal: state.throughOrdinal + 1,
        cappedActual: cappedOf(sets),
        cappedTarget: cappedTargetAt(params, state.units),
        attempts,
        passed,
      });
      attempts = passed ? 1 : attempts + 1;
    }
    return {
      worstOverreach: worst,
      nextAsk: totalAtUnits(params, state.units),
      step: state.step,
    };
  }

  it('stops the plan running away from him', () => {
    const fixed = replayFixed();
    const adaptive = replayAdaptive();

    // The fixed plan ends up asking for 18 reps more than he can do, three sessions running.
    expect(fixed.worstOverreach).toBeGreaterThanOrEqual(18);
    expect(adaptive.worstOverreach).toBeLessThan(fixed.worstOverreach);
  });

  it('does not outrun him at the moment that actually broke him', () => {
    const params = base();
    const totals = fixedTotals(params);

    // 22 June, his twelfth session. The fixed plan asked 100 and he managed 75, and his training
    // gaps went from two days to ten, sixteen, fifteen. That session is index 11.
    const upTo = performed.slice(0, 11);
    let fixedOrdinal = 1;
    for (const sets of upTo) if (totalOf(sets) >= totals[fixedOrdinal - 1]!) fixedOrdinal += 1;

    let state = seedAdaptiveState(params, 1);
    let attempts = 1;
    for (const sets of upTo) {
      const target = totalAtUnits(params, state.units);
      const passed = totalOf(sets) >= target;
      state = observeSession(params, state, {
        ordinal: state.throughOrdinal + 1,
        cappedActual: cappedOf(sets),
        cappedTarget: cappedTargetAt(params, state.units),
        attempts,
        passed,
      });
      attempts = passed ? 1 : attempts + 1;
    }

    const did = totalOf(performed[11]!);
    const fixedAsk = totals[fixedOrdinal - 1]!;
    const adaptiveAsk = totalAtUnits(params, state.units);

    expect(fixedAsk - did).toBeGreaterThanOrEqual(18);
    // Not a miracle, and deliberately not asserted as one: it asks for less than half as much
    // more than he could do. Missing by eight brings you back on Thursday.
    expect(adaptiveAsk - did).toBeLessThan((fixedAsk - did) / 2);
  });

  it('wastes far less of his training than a cruder controller would', () => {
    const params = base();
    let state = seedAdaptiveState(params, 1);
    let attempts = 1;
    let worstSlack = 0;

    for (const sets of performed) {
      const target = totalAtUnits(params, state.units);
      // Slack is the plan asking for less than he can already do. A little is fine. Twenty reps
      // for six sessions running, which a flat failure penalty produced, is wasted training.
      worstSlack = Math.max(worstSlack, totalOf(sets) - target);
      const passed = totalOf(sets) >= target;
      state = observeSession(params, state, {
        ordinal: state.throughOrdinal + 1,
        cappedActual: cappedOf(sets),
        cappedTarget: cappedTargetAt(params, state.units),
        attempts,
        passed,
      });
      attempts = passed ? 1 : attempts + 1;
    }
    expect(worstSlack).toBeLessThanOrEqual(14);
  });

  it('settles on a step near his real rate rather than the curve\'s', () => {
    const { step } = replayAdaptive();
    // He improves at about 6.3% a session; the curve demands 10.6%. In progress units that is
    // roughly log(1.063) / log(1.10613) = 0.61. Anything near or below 1.0 is the point.
    expect(step).toBeLessThan(1);
    expect(step).toBeGreaterThan(STEP_MIN);
  });
});
