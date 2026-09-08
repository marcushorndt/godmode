/**
 * Adaptive pacing: the plan follows what you have demonstrated, instead of a fixed calendar.
 *
 * ## Why this exists
 *
 * The fixed ramp demands a constant +10.6% per session for the reference challenge. A real
 * export of one athlete's eight-year history shows twelve separate attempts at that challenge
 * and not one finish: he improves at 6 to 7% per session, the plan compounds at 10.6, and every
 * block dies in week four or five where the gap becomes a wall. The arithmetic guarantees it.
 * Fixed mode has no way to notice.
 *
 * Adaptive mode does not make anyone stronger. It keeps the prescription in contact with the
 * athlete. Missing by one rep brings you back on Thursday; missing by eighteen, three times
 * running, is where people stop opening the app.
 *
 * ## Progress units
 *
 * The whole mechanism is one change of variable. The fixed ramp is
 *
 *     M(n) = baseline * r ^ (n - 1),   r = (goal / baseline) ^ (1 / (N - 1))
 *
 * so session `n` sits at position `n - 1` on an exponential track. Call that position **u**.
 * Fixed mode advances u by exactly 1.0 per session. Adaptive mode advances it by a `step` that
 * evidence chooses. Nothing else changes: same coefficients, same roles, same rounding, same
 * curve family. A step of 1.0 reproduces the fixed plan exactly, and that is a pinned test.
 *
 * `EXTENSION_DAMPING` is the same idea already shipping: appended sessions advance u by 0.5.
 * Adaptive mode generalises the constant into a controller.
 *
 * ## What the controller may and may not do
 *
 * - It reads only sessions **performed in this app**. Imported history came from a different
 *   curve: on the owner's own file, imported sessions run at 0.87 to 0.98 of our targets, which
 *   would read as a struggling athlete and slam the pace down on day one for no reason.
 * - A **missed** session produces no observation at all, so absence can never ease the plan.
 *   Only a session you trained and did not achieve counts against you. That is a deliberate
 *   asymmetry, and it is why the controller is driven by observations rather than by dates.
 * - The prescription **never goes down**. A failed session holds position and the app repeats it,
 *   which it already does well. Passing is the only thing that advances u.
 * - One observation per **session**, never per attempt. Three attempts at one session are one
 *   piece of evidence that the session was hard, not three reasons to ease. An earlier draft got
 *   this wrong and wound the step down to its floor while the athlete, stuck on one session, saw
 *   no change at all.
 */

import type { SetTarget } from '../types.js';
import {
  type PercentageRampParams,
  baseSessionCount,
  targetsForMax,
} from './percentageRamp.js';

/** How many recent sessions the position is averaged over. One training week at three a week. */
export const OBSERVATION_WINDOW = 3;

/**
 * Bounds on the overload step, in progress units per session.
 *
 * The ceiling sits slightly above 1.0 so an athlete who is beating the fixed curve can be given
 * more than it would have. The floor is not zero: a step of zero is a plan that never moves
 * again, which is a worse failure than one that moves slowly.
 */
export const STEP_MIN = 0.05;
export const STEP_MAX = 1.1;

/**
 * What one session's outcome does to the step. Ease fast, raise slowly.
 *
 * `passedTight` is 1.0 and that is load-bearing. Passing first time is not the same as finding
 * it easy: an athlete who hits exactly the prescribed total has met a demand of +10.6% per
 * session and has proved nothing about having more to give. Rewarding a bare pass with a bigger
 * step would make adaptive mode *harder* than the fixed plan for someone who is exactly on it,
 * which is the opposite of the point. Only a comfortable margin earns acceleration.
 */
export const STEP_FACTORS = {
  passedComfortably: 1.12,
  passedTight: 1.0,
  passedShort: 0.9,
  passedSecondTry: 0.92,
  passedLater: 0.85,
} as const;

/**
 * Bounds on how hard a failed session eases the step.
 *
 * A failure by two reps and a failure by thirty are not the same event, so the factor is the
 * recent mean margin itself, clamped into this band. A near miss barely moves the step; a rout
 * halves it. A flat penalty is what an earlier draft used, and one unlucky opening session
 * cratered the step to 0.55 and left the plan trailing the athlete by twenty reps for six
 * sessions afterwards, which is its own kind of failure.
 */
export const FAILED_FACTOR_MIN = 0.55;
export const FAILED_FACTOR_MAX = 0.95;

/** Mean margin on prescribed work above which recent sessions count as comfortable. */
export const COMFORT_MARGIN = 1.05;

/** Mean margin below which the prescribed work is visibly costing more than it should. */
export const SNUG_MARGIN = 0.97;

/**
 * The controller's whole memory. Serialisable, so it round-trips through `patternParams` and the
 * plan stays reproducible from the record alone.
 */
export interface AdaptivePaceState {
  /** Position of the next session to prescribe. */
  units: number;
  /** Current overload step, in units per session. */
  step: number;
  /**
   * Margins (`achieved / prescribed`) of the last `OBSERVATION_WINDOW` sessions, oldest first.
   *
   * Margins, not positions. An earlier draft averaged the recent *positions* and used that as the
   * anchor for the next session, which lags by half the window and pins the plan in place: an
   * athlete at session `n` would be anchored around session `n - 2` and never advance. The anchor
   * has to be the latest thing demonstrated. Averaging belongs on the step, where its job is to
   * stop one heroic or one dreadful session steering the plan.
   */
  recent: number[];
}

/**
 * One resolved session, judged on the sets that were actually prescribed.
 *
 * **Not the session total.** Set 5 is AMRAP: the athlete is told to do as many as he can, so
 * exceeding the total is the design working, not evidence of spare capacity. An earlier draft
 * anchored on the total and the adaptive plan ran *ahead* of the fixed one for everybody.
 *
 * The colleague's file contains the cleanest possible demonstration. On 22 June he was
 * prescribed `18 · 23 · 18 · 16 · 25+` and did `18 · 23 · 18 · 16 · 0`. By total that is 0.75 and
 * looks like a collapse. By prescribed work it is 1.00: the load was exactly right and he simply
 * did not do the open set. Two weeks later he did `18 · 20 · 17 · 13 · 17`, which by total looks
 * better at 0.85 but by prescribed work is 0.91 and is the one that shows real trouble.
 */
export interface SessionObservation {
  /** Reps actually done on the prescribed (non-AMRAP) sets. */
  cappedActual: number;
  /** Reps those sets asked for. */
  cappedTarget: number;
  /** 1 means first time. Repeats are evidence the session was hard. */
  attempts: number;
  /** Whether the session was ultimately achieved. The app's pass rule owns this, not us. */
  passed: boolean;
}

/** Sum the sets that are not open-ended: the part of a session that is a fixed prescription. */
export function cappedSum(sets: readonly { reps: number; isAmrap?: boolean }[]): number {
  return sets.reduce((sum, set) => (set.isAmrap === true ? sum : sum + set.reps), 0);
}

/** The per-session ratio of the fixed ramp. Above 1 for any plan that climbs. */
export function rampRatio(params: PercentageRampParams): number {
  const sessions = baseSessionCount(params);
  if (sessions < 2) return 1;
  return Math.pow(params.goalMax / params.baselineMax, 1 / (sessions - 1));
}

/**
 * True when the curve has no scale to work on: one session, or a goal equal to the baseline.
 *
 * Both are legitimate plans and both make progress units meaningless, because `log(1)` is zero.
 * Adaptive mode declines to run rather than dividing by it.
 */
export function isFlat(params: PercentageRampParams): boolean {
  return !(rampRatio(params) > 1);
}

/** Generation max at a position on the track. */
export function maxAtUnits(params: PercentageRampParams, units: number): number {
  return params.baselineMax * Math.pow(rampRatio(params), units);
}

/** The position whose generation max is `max`. Inverse of `maxAtUnits`. */
export function unitsForMax(params: PercentageRampParams, max: number): number {
  if (isFlat(params)) throw new RangeError('a flat plan has no progress-unit scale');
  if (!(max > 0)) throw new RangeError(`max must be > 0, received ${max}`);
  return Math.log(max / params.baselineMax) / Math.log(rampRatio(params));
}

/**
 * The position a session total demonstrates.
 *
 * A session's total is `sum over sets of round(M * coefficient)`, so `M` is recovered as
 * `total / sum(coefficients)`. Rounding makes that approximate by well under a rep, which is far
 * finer than a controller reasoning about weeks of training needs.
 */
export function unitsForTotal(params: PercentageRampParams, total: number): number {
  const sum = params.coefficients.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new RangeError('coefficients must sum to more than zero');
  return unitsForMax(params, Math.max(total, 1) / sum);
}

/** The sets an adaptive session prescribes at a given position. */
export function targetsAtUnits(params: PercentageRampParams, units: number): SetTarget[] {
  return targetsForMax(maxAtUnits(params, units), params);
}

/** The session total at a position, which is what the athlete is judged against. */
export function totalAtUnits(params: PercentageRampParams, units: number): number {
  return targetsAtUnits(params, units).reduce((sum, t) => sum + t.reps, 0);
}

function clampStep(step: number): number {
  return Math.min(STEP_MAX, Math.max(STEP_MIN, step));
}

function factorFor(observation: SessionObservation, meanMargin: number): number {
  if (!observation.passed) {
    return Math.min(FAILED_FACTOR_MAX, Math.max(FAILED_FACTOR_MIN, meanMargin));
  }
  if (observation.attempts >= 3) return STEP_FACTORS.passedLater;
  if (observation.attempts === 2) return STEP_FACTORS.passedSecondTry;
  if (meanMargin >= COMFORT_MARGIN) return STEP_FACTORS.passedComfortably;
  if (meanMargin < SNUG_MARGIN) return STEP_FACTORS.passedShort;
  return STEP_FACTORS.passedTight;
}

/** Prescribed work done over prescribed work asked. Floored so a zero target cannot divide. */
function marginOf(observation: SessionObservation): number {
  return observation.cappedActual / Math.max(1, observation.cappedTarget);
}

/**
 * Where adaptive mode starts when the switch is turned on mid-plan.
 *
 * `ordinal` is the session about to be prescribed, so the athlete stands at position
 * `ordinal - 1` on the fixed track. The step is seeded from the recent past rather than assumed:
 * an unseeded step of 1.0 inherits the fixed plan's optimism and produces one over-ambitious
 * jump before any evidence exists.
 *
 * Switching to the gentler mode must never make the next session harder, so the seeded step is
 * capped at 1.0. Turning adaptive mode ON is then never a step up in difficulty, which is the
 * one thing a user switching modes has a right to assume.
 */
export function seedAdaptiveState(
  params: PercentageRampParams,
  ordinal: number,
  history: readonly SessionObservation[] = [],
): AdaptivePaceState {
  if (isFlat(params)) throw new RangeError('a flat plan cannot be paced adaptively');
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`ordinal must be a positive integer, received ${String(ordinal)}`);
  }
  return {
    units: ordinal - 1,
    step: 1,
    recent: history.slice(-OBSERVATION_WINDOW).map(marginOf),
  };
}

/**
 * Fold one resolved session into the state.
 *
 * A pass moves the next position to the average of what has recently been demonstrated, plus the
 * step. Averaging is what stops one heroic or one dreadful session from steering the plan, and
 * the ratchet in the last line is what stops the average dragging the prescription backwards.
 *
 * A failure moves nothing except the step. The plan holds and the app repeats the session, which
 * is the behaviour it already had. Easing the step while the athlete is stuck is the windup this
 * design exists to avoid: the step governs the move to the *next* session and has no authority
 * over the one being failed.
 */
export function observeSession(
  params: PercentageRampParams,
  state: AdaptivePaceState,
  observation: SessionObservation,
): AdaptivePaceState {
  if (isFlat(params)) throw new RangeError('a flat plan cannot be paced adaptively');
  if (!Number.isInteger(observation.attempts) || observation.attempts < 1) {
    throw new RangeError(
      `attempts must be a positive integer, received ${String(observation.attempts)}`,
    );
  }
  if (!Number.isFinite(observation.cappedActual) || observation.cappedActual < 0) {
    throw new RangeError(
      `cappedActual must be a non-negative number, received ${String(observation.cappedActual)}`,
    );
  }

  const recent = [...state.recent, marginOf(observation)].slice(-OBSERVATION_WINDOW);
  const meanMargin = recent.reduce((a, b) => a + b, 0) / recent.length;
  const step = clampStep(state.step * factorFor(observation, meanMargin));

  // A failure moves the step and nothing else. The plan holds and the app repeats the session,
  // which is what it already does. Easing while the athlete is stuck is the windup this design
  // avoids: the step governs the move to the NEXT session and has no authority over this one.
  if (!observation.passed) return { units: state.units, step, recent };

  // Advance from where the plan is, by the step. Deliberately not from what was achieved: with
  // an open-ended set every athlete overshoots, so chasing the achieved total makes the plan
  // accelerate away from exactly the people it exists to keep up with. Because the step is always
  // positive, this is also the ratchet: a prescription can never go down.
  return { units: state.units + step, step, recent };
}

/**
 * The next `count` sessions as adaptive mode currently projects them.
 *
 * The projection holds the step constant. It is deliberately not compounded by the optimistic
 * `passedFirstTry` factor: this is what the athlete is shown, and a forecast that quietly assumes
 * a perfect run is a forecast that is always wrong in the same direction.
 */
export function projectUnits(state: AdaptivePaceState, count: number): number[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, received ${String(count)}`);
  }
  return Array.from({ length: count }, (_, i) => state.units + i * state.step);
}

/** Where this block lands, at the current step, with `remaining` sessions still to do. */
export interface BlockForecast {
  /** Sessions still in the block, including the one about to be prescribed. */
  remaining: number;
  /** Estimated single-set max at the end of the block. */
  finalMax: number;
  /** Session total on the final day. */
  finalTotal: number;
  /** Sessions it would take to reach `goalMax` at this step. Undefined when already past it. */
  sessionsToGoal?: number;
}

/**
 * What to tell the athlete.
 *
 * In adaptive mode the block length is what stays fixed and the goal becomes an outcome, so the
 * honest headline is "six weeks from now you will be at about this", not "you will reach 100".
 * `sessionsToGoal` is offered alongside for anyone who still wants the original number.
 */
export function forecastBlock(
  params: PercentageRampParams,
  state: AdaptivePaceState,
  remaining: number,
): BlockForecast {
  if (!Number.isInteger(remaining) || remaining < 0) {
    throw new RangeError(`remaining must be a non-negative integer, received ${String(remaining)}`);
  }
  const endUnits = remaining === 0 ? state.units : state.units + (remaining - 1) * state.step;
  const goalUnits = unitsForMax(params, params.goalMax);
  const toGoal =
    state.units >= goalUnits ? undefined : Math.ceil((goalUnits - state.units) / state.step) + 1;

  return {
    remaining,
    finalMax: maxAtUnits(params, endUnits),
    finalTotal: totalAtUnits(params, endUnits),
    ...(toGoal === undefined ? {} : { sessionsToGoal: toGoal }),
  };
}
