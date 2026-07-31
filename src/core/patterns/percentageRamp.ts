/**
 * The `percentage-ramp` pattern — the Just 6 Weeks progression scheme.
 *
 * Each session prescribes fixed percentages of a *generation max* that ramps geometrically
 * from a baseline to a goal:
 *
 *   M(n)  = baseline * (goal / baseline) ^ ((n - 1) / (N - 1))
 *   set_i = roundHalfUp(M(n) * coefficient_i)
 *
 * VERIFIED at both endpoints (PLAN.md §1.1):
 *   M=18  -> 7·8·7·6·9+    total 37
 *   M=100 -> 37·47·37·33·51+ total 205
 *
 * NOT verified in between. This curve reproduces 5 of the 18 reference slots exactly and
 * runs high on slots 2-11. It ships because it is inspectable and adjustable, not because
 * it is what the incumbent computes.
 *
 * `goalMax` is a generation coordinate, NOT a capability claim. A challenge with goal 100
 * asserts only "derive the final card from 100" — never "the athlete can do 100 in a row".
 */

import { materialize, type NextSlot, type ProgramPattern, type RestPolicy } from '../contracts.js';
import type { PlanSlotSpec, SetRole, SetTarget } from '../types.js';
import { repsFor } from '../rounding.js';
import {
  DEFAULT_VOLUME_REST_PARAMS,
  volumeDerivedRestPolicy,
  type VolumeDerivedRestParams,
} from '../policies/rest.js';

export const PERCENTAGE_RAMP_ID = 'percentage-ramp';
export const PERCENTAGE_RAMP_VERSION = 1;

export interface PercentageRampParams {
  /** One coefficient per set, applied to the slot's generation max. */
  coefficients: number[];
  roles: SetRole[];
  /** 0-based indices of open-ended sets. Empty is valid; several are valid. */
  amrapIndices: number[];
  /** Starting generation max — normally a tested baseline. */
  baselineMax: number;
  /** Generation max at the final session. Equal to baselineMax gives a fixed-load plan. */
  goalMax: number;
  weeks: number;
  daysPerWeek: number;
  /**
   * Sessions appended *after* the plan's last session, beyond `weeks * daysPerWeek`.
   *
   * Absent — or zero — is an unextended plan, and such a challenge behaves exactly as it did
   * before extension existed. Recorded rather than derived so regenerating the plan from
   * `patternParams` alone reproduces the same slots.
   */
  extraSessions?: number;
  /**
   * Log-space damping applied to the base per-session ratio for appended sessions.
   *
   * Defaults to `EXTENSION_DAMPING`. Persisted alongside `extraSessions` so a later change of
   * the default cannot retroactively re-price sessions the athlete has already trained.
   */
  extensionDamping?: number;
}

export interface PercentageRampState {
  nextOrdinal: number;
}

/**
 * "Climb, but gentler" — half the original ramp's growth, in log space.
 *
 * The base plan's per-session ratio is `r = (goal/baseline)^(1/(N-1))`. An appended session
 * multiplies by `r^0.5` instead, so the curve keeps climbing at half the exponential rate it
 * was climbing at when the plan ran out. For the reference challenge (18 → 100 over 18
 * sessions) that is +10.6%/session becoming +5.2%/session.
 *
 * Halving in log space rather than in reps is what makes the join continuous: the extension
 * starts exactly at `goalMax`, where the base ramp ended, and the growth rate steps down once
 * rather than the prescription itself jumping.
 */
export const EXTENSION_DAMPING = 0.5;

/**
 * The Just 6 Weeks push-up template. Coefficients sum to 2.05, which is why a goal of 100
 * produces a 205-rep terminal session.
 */
export const PUSHUP_5SET_TEMPLATE = {
  id: 'pushup-5set',
  label: 'Push-ups (5 sets)',
  patternId: PERCENTAGE_RAMP_ID,
  coefficients: [0.37, 0.47, 0.37, 0.33, 0.51],
  roles: ['medium', 'big', 'medium', 'small', 'amrap'] as SetRole[],
  amrapIndices: [4],
} as const;

/** Build params for the reference template. */
export function pushupParams(
  baselineMax: number,
  goalMax: number,
  weeks = 6,
  daysPerWeek = 3,
): PercentageRampParams {
  return {
    coefficients: [...PUSHUP_5SET_TEMPLATE.coefficients],
    roles: [...PUSHUP_5SET_TEMPLATE.roles],
    amrapIndices: [...PUSHUP_5SET_TEMPLATE.amrapIndices],
    baselineMax,
    goalMax,
    weeks,
    daysPerWeek,
  };
}

/**
 * The generation max at session `ordinal` (1-based) of `sessions` total.
 *
 * When `goalMax === baselineMax` the ratio is 1, so every session returns the baseline —
 * a flat *fixed-load* plan with no special-casing. Note this is deliberately NOT called
 * "maintenance": a real maintenance program varies stimulus, periodises, and retests. An
 * identical session forever is a degenerate fixed load, useful but not a training model.
 */
export function generationMaxAt(
  ordinal: number,
  sessions: number,
  baselineMax: number,
  goalMax: number,
): number {
  if (sessions < 1) throw new RangeError(`sessions must be >= 1, received ${sessions}`);
  if (!(baselineMax > 0)) throw new RangeError(`baselineMax must be > 0, received ${baselineMax}`);
  if (!(goalMax > 0)) throw new RangeError(`goalMax must be > 0, received ${goalMax}`);
  if (ordinal < 1 || ordinal > sessions) {
    throw new RangeError(`ordinal ${ordinal} out of range 1..${sessions}`);
  }
  if (sessions === 1) return goalMax;
  return baselineMax * Math.pow(goalMax / baselineMax, (ordinal - 1) / (sessions - 1));
}

/** Sessions the plan was originally generated for, before any extension. */
export function baseSessionCount(params: PercentageRampParams): number {
  return params.weeks * params.daysPerWeek;
}

/** Sessions the plan has now, including everything appended by extensions. */
export function totalSessionCount(params: PercentageRampParams): number {
  return baseSessionCount(params) + (params.extraSessions ?? 0);
}

/**
 * The generation max of the `k`-th appended session (k = 1, 2, 3, …).
 *
 *   M(N + k) = goalMax * (goalMax / baselineMax) ^ (damping * k / (N - 1))
 *
 * `N` is the **base** session count and never the extended one. That is the whole safety
 * property of this design: `N` sits in the denominator of the base ramp's exponent, so
 * recomputing it from a grown total would silently rewrite the prescription of every session
 * already performed. Appending sessions therefore changes nothing about `M(1..N)`.
 *
 * A one-session base plan, or a flat one where goal equals baseline, has no ratio to damp; both
 * fall out as a continued hold at `goalMax` rather than a special case.
 */
export function extendedGenerationMaxAt(
  k: number,
  baseSessions: number,
  baselineMax: number,
  goalMax: number,
  damping: number = EXTENSION_DAMPING,
): number {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, received ${k}`);
  if (baseSessions < 1) throw new RangeError(`baseSessions must be >= 1, received ${baseSessions}`);
  if (!(baselineMax > 0)) throw new RangeError(`baselineMax must be > 0, received ${baselineMax}`);
  if (!(goalMax > 0)) throw new RangeError(`goalMax must be > 0, received ${goalMax}`);
  if (!Number.isFinite(damping) || damping < 0) {
    throw new RangeError(`damping must be a finite number >= 0, received ${damping}`);
  }
  if (baseSessions === 1) return goalMax;
  return goalMax * Math.pow(goalMax / baselineMax, (damping * k) / (baseSessions - 1));
}

function validateParams(params: PercentageRampParams): void {
  const { coefficients, roles, amrapIndices, weeks, daysPerWeek } = params;
  const { extraSessions, extensionDamping } = params;
  if (extraSessions !== undefined && (!Number.isInteger(extraSessions) || extraSessions < 0)) {
    throw new RangeError(
      `extraSessions must be a non-negative integer, received ${String(extraSessions)}`,
    );
  }
  if (
    extensionDamping !== undefined &&
    (!Number.isFinite(extensionDamping) || extensionDamping < 0)
  ) {
    throw new RangeError(
      `extensionDamping must be a finite number >= 0, received ${String(extensionDamping)}`,
    );
  }
  if (coefficients.length === 0) throw new RangeError('coefficients must not be empty');
  if (coefficients.length !== roles.length) {
    throw new RangeError(
      `coefficients (${coefficients.length}) and roles (${roles.length}) must match in length`,
    );
  }
  if (coefficients.some((c) => !(c > 0))) throw new RangeError('every coefficient must be > 0');
  for (const i of amrapIndices) {
    if (!Number.isInteger(i) || i < 0 || i >= coefficients.length) {
      throw new RangeError(`amrapIndex ${i} out of range 0..${coefficients.length - 1}`);
    }
  }
  if (new Set(amrapIndices).size !== amrapIndices.length) {
    throw new RangeError('amrapIndices must not contain duplicates');
  }
  if (!Number.isInteger(weeks) || weeks < 1) {
    throw new RangeError(`weeks must be a positive integer, received ${weeks}`);
  }
  if (!Number.isInteger(daysPerWeek) || daysPerWeek < 1) {
    throw new RangeError(`daysPerWeek must be a positive integer, received ${daysPerWeek}`);
  }
}

/** Build set targets for a given generation max. Exported for invariant testing. */
export function targetsForMax(
  generationMax: number,
  shape: Pick<PercentageRampParams, 'coefficients' | 'roles' | 'amrapIndices'>,
): SetTarget[] {
  const amrap = new Set(shape.amrapIndices);
  return shape.coefficients.map((coefficient, i) => ({
    index: i + 1,
    targetKind: 'reps' as const,
    // A prescribed set is never zero reps — "do 0" is a bug, not a rest set.
    reps: Math.max(1, repsFor(generationMax, coefficient)),
    role: shape.roles[i]!,
    isAmrap: amrap.has(i),
  }));
}

/**
 * The pattern. Deterministic, so `next()` ignores `history` — but the signature accepts it
 * so an adaptive successor pattern can use it without changing the interface.
 */
export function createPercentageRampPattern(
  restPolicy: RestPolicy<VolumeDerivedRestParams> = volumeDerivedRestPolicy,
  restParams: VolumeDerivedRestParams = DEFAULT_VOLUME_REST_PARAMS,
): ProgramPattern<PercentageRampParams, PercentageRampState> {
  return {
    id: PERCENTAGE_RAMP_ID,
    version: PERCENTAGE_RAMP_VERSION,

    plannedSessionCount(params) {
      validateParams(params);
      return totalSessionCount(params);
    },

    initialState(params) {
      validateParams(params);
      return { nextOrdinal: 1 };
    },

    next({ params, state }): NextSlot<PercentageRampState> | null {
      validateParams(params);
      const baseSessions = baseSessionCount(params);
      const sessions = totalSessionCount(params);
      const damping = params.extensionDamping ?? EXTENSION_DAMPING;
      const ordinal = state.nextOrdinal;
      if (ordinal > sessions) return null;

      // The base ramp is computed against `baseSessions`, never `sessions`. See
      // `extendedGenerationMaxAt`: this is what keeps an extension from rewriting history.
      const generationMax =
        ordinal <= baseSessions
          ? generationMaxAt(ordinal, baseSessions, params.baselineMax, params.goalMax)
          : extendedGenerationMaxAt(
              ordinal - baseSessions,
              baseSessions,
              params.baselineMax,
              params.goalMax,
              damping,
            );
      const targets = targetsForMax(generationMax, params);
      const targetTotal = targets.reduce((sum, t) => sum + t.reps, 0);

      const rest = restPolicy.prescribe({ ordinal, targets, targetTotal }, restParams);
      const withRest: SetTarget[] = targets.map((t, i) => {
        const perSet = rest.restAfterSeconds?.[i];
        return perSet === undefined ? t : { ...t, restAfterSeconds: perSet };
      });

      const slot: PlanSlotSpec = {
        ordinal,
        week: Math.floor((ordinal - 1) / params.daysPerWeek) + 1,
        day: ((ordinal - 1) % params.daysPerWeek) + 1,
        targets: withRest,
        targetTotal,
        restSeconds: rest.restSeconds,
        patternMetrics: { generationMax },
      };

      return {
        slot,
        nextState: { nextOrdinal: ordinal + 1 },
        decision: {
          patternId: PERCENTAGE_RAMP_ID,
          patternVersion: PERCENTAGE_RAMP_VERSION,
          ordinal,
          sessions,
          baseSessions,
          extended: ordinal > baseSessions,
          generationMax,
          restPolicyId: restPolicy.id,
          restPolicyVersion: restPolicy.version,
        },
      };
    },
  };
}

export const percentageRampPattern = createPercentageRampPattern();

/**
 * The slots one more block of sessions would append, and nothing else.
 *
 * Pure: no ids, no timestamps, no storage — the caller turns these specs into records. It
 * materialises the *whole* extended plan and returns only the tail, which is deliberate: it
 * proves, every time it runs, that the prefix it discards is the plan that already exists,
 * rather than assuming it.
 *
 * IMP-07: computed from the challenge's own parameters. Nothing performed is consulted.
 */
export function extensionSlots(params: PercentageRampParams, count: number): PlanSlotSpec[] {
  const before = totalSessionCount(params);
  return materialize(percentageRampPattern, extendParams(params, count)).slice(before);
}

/**
 * The same params with `count` more sessions appended.
 *
 * `extraSessions` accumulates, so extending twice continues where the first extension stopped
 * instead of starting over from `goalMax`. `extensionDamping` is written down explicitly the
 * first time an extension happens, so the curve is reproducible from the record alone.
 */
export function extendParams(
  params: PercentageRampParams,
  count: number,
  damping: number = params.extensionDamping ?? EXTENSION_DAMPING,
): PercentageRampParams {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`count must be a positive integer, received ${count}`);
  }
  return {
    ...params,
    extraSessions: (params.extraSessions ?? 0) + count,
    extensionDamping: damping,
  };
}
