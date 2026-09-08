/**
 * Record builders — everything the retired `repo.ts` did *before* it touched storage.
 *
 * The split is the point of the cutover. Generating a plan, evaluating a performance and
 * composing a workout record are decisions this client owns and always did; writing them down
 * is now the server's job. So these functions build and return records and write nothing, and
 * the API commands in `src/api/` take what they return.
 *
 * No storage and no `fetch` in this file. It is not in `src/core/` because it mints ids and
 * reads the clock, which `core/` deliberately does not — but everything below is otherwise a
 * pure function of its arguments.
 */

import { materialize } from '../core/contracts.js';
import {
  extendParams,
  extensionSlots,
  percentageRampPattern,
  totalSessionCount,
  type PercentageRampParams,
} from '../core/patterns/percentageRamp.js';
import {
  isFlat,
  maxAtUnits,
  observeSession,
  seedAdaptiveState,
  targetsAtUnits,
  type AdaptivePaceState,
  type SessionObservation,
} from '../core/patterns/adaptivePace.js';
import { DEFAULT_VOLUME_REST_PARAMS, volumeDerivedRestPolicy } from '../core/policies/rest.js';
import {
  TOTAL_REPS_POLICY_ID,
  TOTAL_REPS_POLICY_VERSION,
  classifyOutcome,
  manualAdvance,
  totalRepsAtLeastTargetPolicy,
} from '../core/policies/evaluation.js';
import type {
  Baseline,
  EvaluationResult,
  PerformanceTest,
  PlanSlotSpec,
  SeedStrategy,
  WorkoutPerformance,
} from '../core/types.js';
import {
  KCAL_ESTIMATOR_VERSION,
  type ChallengeRecord,
  type ExerciseRecord,
  type PendingWorkout,
  type PlanSlotRecord,
  type WorkoutRecord,
  type SettingsRecord,
} from './schema.js';

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

const nowIso = () => new Date().toISOString();

// ── Exercises and tests ─────────────────────────────────────────────────────────

export function buildExercise(label: string): ExerciseRecord {
  return {
    id: newId('ex'),
    label: label.trim() || 'Exercise',
    unit: 'reps',
    createdAt: nowIso(),
  };
}

export function buildMaxTest(
  exerciseId: string,
  value: number,
  challengeId?: string,
): PerformanceTest {
  return {
    id: newId('test'),
    exerciseId,
    performedAt: nowIso(),
    protocolId: 'single-set-max-v1',
    protocolVersion: 1,
    value,
    unit: 'reps',
    ...(challengeId === undefined ? {} : { challengeId }),
  };
}

// ── Challenges ──────────────────────────────────────────────────────────────────

export interface CreateChallengeInput {
  exerciseId: string;
  params: PercentageRampParams;
  baseline: Baseline;
  /** Continues an existing chain. Omit to start a new one. */
  previousChallengeId?: string;
  chainId?: string;
}

/** Build a challenge and its slots. Writes nothing; the caller sends them as one command. */
export function buildChallenge(input: CreateChallengeInput): {
  challenge: ChallengeRecord;
  slots: PlanSlotRecord[];
} {
  const id = newId('ch');
  const generatedAt = nowIso();

  const challenge: ChallengeRecord = {
    id,
    exerciseId: input.exerciseId,
    chainId: input.chainId ?? input.previousChallengeId ?? id,
    patternId: percentageRampPattern.id,
    patternVersion: percentageRampPattern.version,
    patternParams: { ...input.params } as unknown as Record<string, unknown>,
    restPolicyId: volumeDerivedRestPolicy.id,
    restPolicyVersion: volumeDerivedRestPolicy.version,
    restPolicyParams: { ...DEFAULT_VOLUME_REST_PARAMS },
    evaluationPolicyId: TOTAL_REPS_POLICY_ID,
    evaluationPolicyVersion: TOTAL_REPS_POLICY_VERSION,
    baseline: input.baseline,
    goalValue: input.params.goalMax,
    status: 'active',
    startedAt: generatedAt,
    ...(input.previousChallengeId === undefined
      ? {}
      : { previousChallengeId: input.previousChallengeId }),
  };

  const specs = materialize(percentageRampPattern, input.params);
  const slots = specs.map((spec) => specToRecord(spec, id, generatedAt));

  return { challenge, slots };
}

function specToRecord(
  spec: PlanSlotSpec,
  challengeId: string,
  generatedAt: string,
): PlanSlotRecord {
  return {
    id: newId('slot'),
    challengeId,
    ordinal: spec.ordinal,
    patternId: percentageRampPattern.id,
    patternVersion: percentageRampPattern.version,
    generatedAt,
    targets: spec.targets,
    targetTotal: spec.targetTotal,
    restSeconds: spec.restSeconds,
    status: 'available',
    ...(spec.week === undefined ? {} : { week: spec.week }),
    ...(spec.day === undefined ? {} : { day: spec.day }),
    ...(spec.cycleLabel === undefined ? {} : { cycleLabel: spec.cycleLabel }),
    ...(spec.patternMetrics === undefined ? {} : { patternMetrics: spec.patternMetrics }),
  };
}

/**
 * Everything the next block of a chain needs, ready to be sent as one command.
 *
 * The baseline for the successor is the caller's explicit decision, carrying provenance. We
 * deliberately do NOT default it to the previous goal or to the best AMRAP result: a goal is a
 * generation coordinate, and an AMRAP performed after 150 preceding reps is a fatigued
 * measurement. Neither is a rested max.
 *
 * The previous block's `ended` record is not built here. `POST /api/challenges/next-block`
 * derives it inside its own transaction from the challenge it already holds — a client that
 * composed the ended record would be sending a copy of a record it might have read minutes ago.
 */
export function buildNextBlock(input: {
  previous: ChallengeRecord;
  strategy: SeedStrategy;
  baselineValue: number;
  goalValue: number;
  weeks: number;
  daysPerWeek: number;
  /** Whether the new baseline came from a rested test taken just now. */
  tested: boolean;
}): {
  challenge: ChallengeRecord;
  slots: PlanSlotRecord[];
  performanceTest?: PerformanceTest;
  endedAt: string;
} {
  if (!Number.isFinite(input.baselineValue) || input.baselineValue <= 0) {
    throw new Error('The new baseline must be a positive number. Nothing has been changed.');
  }
  if (!Number.isFinite(input.goalValue) || input.goalValue <= 0) {
    throw new Error('The new goal must be a positive number. Nothing has been changed.');
  }

  const previousParams = input.previous.patternParams as unknown as PercentageRampParams;
  const test = input.tested
    ? buildMaxTest(input.previous.exerciseId, input.baselineValue)
    : undefined;

  const baseline: Baseline = {
    value: input.baselineValue,
    source: input.tested ? 'tested' : 'user_entered',
    recordedAt: nowIso(),
    ...(test === undefined ? {} : { evidenceId: test.id }),
  };

  const { challenge, slots } = buildChallenge({
    exerciseId: input.previous.exerciseId,
    previousChallengeId: input.previous.id,
    chainId: input.previous.chainId,
    baseline,
    params: {
      coefficients: [...previousParams.coefficients],
      roles: [...previousParams.roles],
      amrapIndices: [...previousParams.amrapIndices],
      baselineMax: input.baselineValue,
      goalMax: input.goalValue,
      weeks: input.weeks,
      daysPerWeek: input.daysPerWeek,
    },
  });

  return {
    challenge,
    slots,
    ...(test === undefined ? {} : { performanceTest: test }),
    endedAt: nowIso(),
  };
}

// ── Extending a plan ────────────────────────────────────────────────────────────

/** What an extension would add, before anything is sent. */
export interface PlanExtension {
  /** The same challenge with its `patternParams` carrying the new `extraSessions`. */
  challenge: ChallengeRecord;
  /** ONLY the appended slots. Nothing that already exists appears here. */
  slots: PlanSlotRecord[];
  /** Session numbers the extension adds, for the confirmation the user is shown. */
  firstOrdinal: number;
}

/**
 * Why a plan cannot be extended, because the two cases deserve different treatment.
 *
 * `unsupported` is not a fault — a pattern that has no notion of appending sessions simply does
 * not offer the button, and saying so would be noise. `inconsistent` is a fault: the plan on
 * screen does not match what its own parameters describe, and the owner is owed the sentence.
 */
export type PlanExtensionRefusal = 'unsupported' | 'inconsistent';

export class PlanExtensionError extends Error {
  readonly reason: PlanExtensionRefusal;

  constructor(reason: PlanExtensionRefusal, message: string) {
    super(message);
    this.name = 'PlanExtensionError';
    this.reason = reason;
  }
}

/**
 * Append another block of sessions to a plan that has run out, without touching a single one of
 * the sessions already in it.
 *
 * The trap this function exists to avoid: `weeks` is not incremented. `N = weeks * daysPerWeek`
 * is the denominator of the base ramp's exponent, so raising it would recompute `M(n)` for every
 * session — silently rewriting prescriptions the athlete has already performed, on slots that
 * workouts reference. Instead `extraSessions` grows and `N` is frozen, which is why the existing
 * slots come back byte-identical (`percentageRamp.test.ts`, "an extension leaves every existing
 * slot untouched").
 *
 * IMP-07: the new sessions are computed from `patternParams` alone. No workout is read, here or
 * anywhere below this call.
 */
export function buildExtension(input: {
  challenge: ChallengeRecord;
  /** The challenge's live slots — what `slotsFor` returns. Used to check, never to derive. */
  existingSlots: readonly PlanSlotRecord[];
  /** Sessions to append. Defaults to one week of them. */
  sessions?: number;
}): PlanExtension {
  const { challenge } = input;
  if (challenge.status !== 'active') {
    throw new PlanExtensionError(
      'unsupported',
      'This workout has ended, so its plan cannot be extended.',
    );
  }
  if (challenge.patternId !== percentageRampPattern.id) {
    throw new PlanExtensionError(
      'unsupported',
      `Only a ${percentageRampPattern.id} plan can be extended; this one is ` +
        `"${challenge.patternId}".`,
    );
  }

  const params = challenge.patternParams as unknown as PercentageRampParams;
  const before = totalSessionCount(params);
  assertPlanIsWhole(input.existingSlots, before);

  const count = input.sessions ?? params.daysPerWeek;
  const nextParams = extendParams(params, count);
  const generatedAt = nowIso();
  const specs = extensionSlots(params, count);

  return {
    challenge: {
      ...challenge,
      patternParams: { ...nextParams } as unknown as Record<string, unknown>,
    },
    slots: specs.map((spec) => specToRecord(spec, challenge.id, generatedAt)),
    firstOrdinal: before + 1,
  };
}

/** Everything a re-pace needs, ready to be sent as one command. */
export interface PlanRepace {
  /** The same challenge with its `patternParams` carrying the new pacing state. */
  challenge: ChallengeRecord;
  /** Replacements for the sessions ahead. Each supersedes exactly one existing slot. */
  slots: PlanSlotRecord[];
}

/**
 * Turn adaptive pacing on for a challenge, starting exactly where the fixed plan stands.
 *
 * Seeding at `ordinal - 1` with a step of 1.0 is what makes switching mode safe: the next session
 * is byte-identical to the one fixed mode would have given, and the plan only starts to diverge
 * once there is evidence to diverge on.
 */
export function enableAdaptivePace(
  challenge: ChallengeRecord,
  nextOrdinal: number,
): ChallengeRecord {
  const params = challenge.patternParams as unknown as PercentageRampParams;
  if (challenge.patternId !== percentageRampPattern.id || isFlat(params)) {
    throw new PlanExtensionError(
      'unsupported',
      'This plan has no curve to pace, so it cannot follow your training.',
    );
  }
  return {
    ...challenge,
    patternParams: {
      ...challenge.patternParams,
      adaptivePace: seedAdaptiveState(params, nextOrdinal),
    } as unknown as Record<string, unknown>,
  };
}

/** Turn it off, leaving the sessions already written exactly as they are. */
export function disableAdaptivePace(challenge: ChallengeRecord): ChallengeRecord {
  const params = { ...challenge.patternParams };
  delete params['adaptivePace'];
  return { ...challenge, patternParams: params };
}

/** The pacing state a challenge carries, or undefined when it is on the fixed plan. */
export function adaptivePaceOf(challenge: ChallengeRecord): AdaptivePaceState | undefined {
  const raw = challenge.patternParams['adaptivePace'];
  if (raw === null || typeof raw !== 'object') return undefined;
  const state = raw as Partial<AdaptivePaceState>;
  if (
    typeof state.units !== 'number' ||
    typeof state.step !== 'number' ||
    typeof state.throughOrdinal !== 'number' ||
    !Array.isArray(state.recent)
  ) {
    return undefined;
  }
  return {
    units: state.units,
    step: state.step,
    recent: state.recent.filter((n): n is number => typeof n === 'number'),
    throughOrdinal: state.throughOrdinal,
  };
}

/**
 * What a finished session teaches the controller, or nothing when it must be ignored.
 *
 * Returns undefined for a slot whose history came from an import. That is the rule stated in
 * `adaptivePace.ts` and it is enforced here, at the only place that turns stored rows into
 * observations: imported sessions were prescribed by a different curve, and on the owner's own
 * file they run at 0.87 to 0.98 of ours, which would read as a struggling athlete and ease the
 * plan on day one for a reason that has nothing to do with him.
 */
function observationFor(
  slot: PlanSlotRecord,
  workouts: readonly WorkoutRecord[],
): SessionObservation | undefined {
  const attempts = workouts.filter((w) => w.planSlotId === slot.id);
  if (attempts.length === 0) return undefined;
  if (attempts.some((w) => w.importSource !== undefined)) return undefined;

  const cappedTarget = slot.targets.reduce((sum, t) => (t.isAmrap ? sum : sum + t.reps), 0);
  const cappedActual = Math.max(
    ...attempts.map((w) =>
      w.sets.reduce((sum, set, i) => (slot.targets[i]?.isAmrap === true ? sum : sum + set.actual), 0),
    ),
  );

  return {
    ordinal: slot.ordinal,
    cappedActual,
    cappedTarget,
    attempts: attempts.length,
    passed: slot.status === 'completed',
  };
}

/**
 * Re-price the sessions ahead from what has been trained since the last time this ran.
 *
 * Returns `null` when there is nothing to do: the challenge is not paced adaptively, no session
 * has resolved since the state was last folded, or the recomputed sessions are identical to the
 * ones already stored. Writing rows that say the same thing would churn the plan for nothing.
 *
 * Only `available` slots are replaced, which is the same rule the server enforces again against
 * what it actually holds. This side cannot see another device.
 */
export function buildRepace(input: {
  challenge: ChallengeRecord;
  existingSlots: readonly PlanSlotRecord[];
  workouts: readonly WorkoutRecord[];
}): PlanRepace | null {
  const { challenge } = input;
  if (challenge.status !== 'active') return null;
  if (challenge.patternId !== percentageRampPattern.id) return null;

  const params = challenge.patternParams as unknown as PercentageRampParams;
  if (isFlat(params)) return null;
  const before = adaptivePaceOf(challenge);
  if (before === undefined) return null;

  const resolved = [...input.existingSlots]
    .filter((slot) => slot.status === 'completed' || slot.status === 'attempted')
    .sort((a, b) => a.ordinal - b.ordinal);

  let state = before;
  for (const slot of resolved) {
    const observation = observationFor(slot, input.workouts);
    if (observation !== undefined) state = observeSession(params, state, observation);
  }
  if (state.throughOrdinal === before.throughOrdinal) return null;

  const ahead = [...input.existingSlots]
    .filter((slot) => slot.status === 'available')
    .sort((a, b) => a.ordinal - b.ordinal);

  const generatedAt = nowIso();
  const slots: PlanSlotRecord[] = [];
  ahead.forEach((slot, i) => {
    const units = state.units + i * state.step;
    const targets = targetsAtUnits(params, units);
    const targetTotal = targets.reduce((sum, t) => sum + t.reps, 0);
    if (targetTotal === slot.targetTotal) return; // already says this; leave the row alone
    slots.push({
      ...slot,
      id: newId('slot'),
      generatedAt,
      targets,
      targetTotal,
      patternMetrics: { generationMax: maxAtUnits(params, units) },
      decision: {
        reason: 'adaptive-pace',
        units,
        step: state.step,
        previousTargetTotal: slot.targetTotal,
      },
      status: 'available',
      supersedesId: slot.id,
    });
  });

  if (slots.length === 0) return null;
  return {
    challenge: {
      ...challenge,
      patternParams: {
        ...challenge.patternParams,
        adaptivePace: state,
      } as unknown as Record<string, unknown>,
    },
    slots,
  };
}

/**
 * Every session the params claim exists, exactly once.
 *
 * Appending to a plan with a hole in it would put the new sessions after a gap the user would
 * never reach, and appending to one that already has more slots than its params describe would
 * collide with them. Both are refused before anything is composed, and the server checks the
 * same thing again against what it actually holds — this side cannot see another device.
 */
function assertPlanIsWhole(slots: readonly PlanSlotRecord[], expected: number): void {
  const ordinals = new Set(slots.map((s) => s.ordinal));
  if (ordinals.size !== slots.length || slots.length !== expected) {
    throw new PlanExtensionError(
      'inconsistent',
      `This plan should hold ${String(expected)} sessions but holds ${String(slots.length)}. ` +
        'Nothing has been changed.',
    );
  }
  for (let ordinal = 1; ordinal <= expected; ordinal += 1) {
    if (!ordinals.has(ordinal)) {
      throw new PlanExtensionError(
        'inconsistent',
        `This plan is missing session ${String(ordinal)}. Nothing has been changed.`,
      );
    }
  }
}

// ── Workouts ────────────────────────────────────────────────────────────────────

export function estimateKcal(
  totalReps: number,
  bodyweightKg: number | undefined,
  coefficient: number,
): number | undefined {
  if (!bodyweightKg || bodyweightKg <= 0) return undefined;
  return Math.round(totalReps * bodyweightKg * coefficient);
}

export interface BuildWorkoutInput {
  /** The id minted when the session started — the draft's id, and the idempotency key. */
  workoutId: string;
  challenge: ChallengeRecord;
  slot: PlanSlotRecord;
  performance: WorkoutPerformance;
  durationSeconds?: number;
  /** Explicit user override: advance despite not satisfying the prescription. */
  manuallyAdvance?: boolean;
  performedAt?: string;
  note?: string;
  settings: SettingsRecord;
}

/**
 * Compose the finished workout, and evaluate it.
 *
 * `attemptNo` is absent, and its absence is load-bearing: the server assigns it as
 * `MAX(attempt_no) + 1` for the slot inside the transaction that stores the workout, and
 * refuses a command that supplies one. A client counting attempts is a client racing every
 * other device — which is the bug `repo.ts:660` used to have inside one browser and would have
 * had across two.
 */
export function buildWorkout(input: BuildWorkoutInput): {
  workout: PendingWorkout;
  evaluation: EvaluationResult;
} {
  const spec: PlanSlotSpec = {
    ordinal: input.slot.ordinal,
    targets: input.slot.targets,
    targetTotal: input.slot.targetTotal,
    restSeconds: input.slot.restSeconds,
  };

  const manual = input.manuallyAdvance === true;
  const evaluation = manual
    ? manualAdvance(spec, input.performance)
    : totalRepsAtLeastTargetPolicy.evaluate(spec, input.performance);

  const kcalValue = estimateKcal(
    input.performance.actualTotal,
    input.settings.bodyweightKg,
    input.settings.kcalCoefficient,
  );

  const workout: PendingWorkout = {
    id: input.workoutId,
    challengeId: input.challenge.id,
    chainId: input.challenge.chainId,
    planSlotId: input.slot.id,
    performedAt: input.performedAt ?? nowIso(),
    sets: input.performance.sets,
    actualTotal: input.performance.actualTotal,
    adjustmentType: input.performance.adjustmentType,
    effectiveTotal: input.performance.effectiveTotal,
    outcome: classifyOutcome(evaluation, input.performance.adjustmentType, manual),
    evaluation,
    evaluationPolicyId: TOTAL_REPS_POLICY_ID,
    evaluationPolicyVersion: TOTAL_REPS_POLICY_VERSION,
    ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(kcalValue === undefined
      ? {}
      : {
          kcal: {
            value: kcalValue,
            source: 'estimated' as const,
            estimatorVersion: KCAL_ESTIMATOR_VERSION,
          },
        }),
  };

  return { workout, evaluation };
}
