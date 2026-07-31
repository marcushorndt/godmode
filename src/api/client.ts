/**
 * The typed API client. Everything the app knows about its own data comes through here.
 *
 * ## One origin, cookie auth, no token in JavaScript
 *
 * The session is an `HttpOnly; Secure; SameSite=Strict` cookie the server sets when the token
 * is exchanged at `POST /api/session` (`.planning/DESIGN-server-sqlite.md` §9). Script cannot
 * read it, so there is nothing here to leak: **the raw token appears in exactly one place, the
 * argument to `openSession`, and is never stored, logged, put in a URL or attached to an error.**
 * Every request is same-origin and relative, so the cookie rides along by itself and
 * `SameSite=Strict` stays a complete CSRF defence.
 *
 * ## Failures are classified, because the UI has to say different things
 *
 * "Saved", "queued offline", "someone else changed this", "sign in again" and "the server is not
 * there" are five different sentences and the user is owed the right one. `ApiError.kind` is
 * what the shell switches on; the HTTP status alone cannot distinguish a dead network from a
 * refused request, because a dead network produces no status at all.
 */

import type { PerformanceTest } from '../core/types.js';
import type {
  ChallengeRecord,
  ExerciseRecord,
  PendingWorkout,
  PlanSlotRecord,
  SettingsRecord,
  WorkoutRecord,
} from '../db/schema.js';

/** Must match `API_VERSION` in `server/routes.ts`. A mismatch is reported, never worked around. */
export const EXPECTED_API_VERSION = 1;

export interface Snapshot {
  readonly apiVersion: number;
  readonly schemaVersion: number;
  readonly revision: number;
  readonly exercises: readonly ExerciseRecord[];
  readonly challenges: readonly ChallengeRecord[];
  readonly planSlots: readonly PlanSlotRecord[];
  readonly workouts: readonly WorkoutRecord[];
  readonly performanceTests: readonly PerformanceTest[];
  readonly settings: SettingsRecord;
}

export type ApiErrorKind =
  /** No response at all: offline, server down, DNS, a proxy that is not running. */
  | 'unreachable'
  /** 401. The session is gone or was never opened. */
  | 'unauthorised'
  /** 409. Someone else moved first; `snapshot` carries the current state. */
  | 'conflict'
  /** 4xx that retrying cannot fix: a malformed or no-longer-valid command. */
  | 'refused'
  /** 5xx, or a response this build cannot parse. Retrying may work. */
  | 'server'
  /** The server speaks a different API version. */
  | 'version';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string;
  /** Present on every 409: the fresh state, so the UI never has to guess what changed. */
  readonly snapshot: Snapshot | undefined;
  readonly details: unknown;

  constructor(init: {
    kind: ApiErrorKind;
    status: number;
    code: string;
    message: string;
    snapshot?: Snapshot | undefined;
    details?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.snapshot = init.snapshot;
    this.details = init.details;
  }

  /** Worth trying the exact same command again later, unchanged. */
  get retryable(): boolean {
    return this.kind === 'unreachable' || this.kind === 'server';
  }
}

function classify(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorised';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  if (status === 429) return 'server';
  return 'refused';
}

interface RequestInitLite {
  method: string;
  path: string;
  body?: unknown;
  /** Expected success statuses. Anything else is an error even if it is 2xx. */
  expect: readonly number[];
}

async function request<T>(init: RequestInitLite): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${init.path}`, {
      method: init.method,
      // Same-origin. Never `include`: this app has no cross-origin API and asking for one
      // would be the first half of the change that reopens CSRF.
      credentials: 'same-origin',
      headers:
        init.body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (cause) {
    // `fetch` rejects only for network-level failures. There is no status to report and
    // nothing about the request is echoed back — a rejected request may carry a token.
    throw new ApiError({
      kind: 'unreachable',
      status: 0,
      code: 'unreachable',
      message: 'The server is not answering. Nothing has been sent.',
      details: cause instanceof Error ? cause.name : undefined,
    });
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (init.expect.includes(response.status)) return payload as T;

  const body = (payload ?? {}) as Record<string, unknown>;
  const kind = classify(response.status);
  throw new ApiError({
    kind,
    status: response.status,
    code: typeof body['error'] === 'string' ? body['error'] : 'unexpected_status',
    message:
      typeof body['message'] === 'string'
        ? body['message']
        : `The server answered ${String(response.status)}.`,
    snapshot: isSnapshot(body['snapshot']) ? body['snapshot'] : undefined,
    details: body['details'],
  });
}

function isSnapshot(value: unknown): value is Snapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Snapshot).revision === 'number' &&
    Array.isArray((value as Snapshot).workouts)
  );
}

/**
 * Refuse a snapshot this build cannot read, rather than rendering half of it.
 *
 * §8 of the design: an incompatible client gets one explicit screen instead of a cascade of
 * failures in six different places.
 */
function checkVersion(snapshot: Snapshot): Snapshot {
  if (snapshot.apiVersion !== EXPECTED_API_VERSION) {
    throw new ApiError({
      kind: 'version',
      status: 200,
      code: 'api_version_mismatch',
      message:
        `This app speaks API version ${String(EXPECTED_API_VERSION)} and the server speaks ` +
        `${String(snapshot.apiVersion)}. Reload to pick up the current version of the app.`,
    });
  }
  return snapshot;
}

// ── Session ─────────────────────────────────────────────────────────────────────

export interface SessionState {
  authenticated: boolean;
  apiVersion: number;
}

export function sessionState(): Promise<SessionState> {
  return request<SessionState>({ method: 'GET', path: '/session', expect: [200] });
}

/**
 * Exchange the shared token for the session cookie.
 *
 * The token is a parameter and nothing else: it is not stored, not echoed into any error
 * message here, and the server is careful never to reflect it either (`server/routes.ts:856`).
 */
export function openSession(token: string): Promise<{ authenticated: true; expiresAt: string }> {
  return request({ method: 'POST', path: '/session', body: { token }, expect: [200] });
}

export function closeSession(): Promise<void> {
  return request<void>({ method: 'DELETE', path: '/session', expect: [204] });
}

// ── Reads ───────────────────────────────────────────────────────────────────────

export async function getSnapshot(): Promise<Snapshot> {
  return checkVersion(
    await request<Snapshot>({ method: 'GET', path: '/snapshot', expect: [200] }),
  );
}

// ── Commands ────────────────────────────────────────────────────────────────────

export interface WorkoutAccepted {
  workout: WorkoutRecord;
  attemptNo: number;
  /** True when this id was already stored: a retry, not a second session. */
  duplicate: boolean;
  snapshot: Snapshot;
}

/**
 * Append a finished workout.
 *
 * Deliberately carries no `expectedRevision`, and that is the design rather than an oversight:
 * a workout drained from the outbox was composed against a revision that is stale by
 * definition. It is append-only and idempotent on the client-generated id instead
 * (`server/routes.ts:22-27`).
 */
export function postWorkout(workout: PendingWorkout): Promise<WorkoutAccepted> {
  return request({ method: 'POST', path: '/workouts', body: { workout }, expect: [201] });
}

export interface CommandResult {
  challengeId: string;
  snapshot: Snapshot;
}

export function createChallenge(body: {
  expectedRevision: number;
  exercise?: ExerciseRecord;
  performanceTest?: PerformanceTest;
  challenge: ChallengeRecord;
  slots: readonly PlanSlotRecord[];
  select?: boolean;
}): Promise<CommandResult> {
  return request({ method: 'POST', path: '/challenges', body, expect: [201] });
}

export function endChallenge(
  challengeId: string,
  body: { expectedRevision: number; endReason: string; endedAt: string },
): Promise<CommandResult> {
  return request({
    method: 'POST',
    path: `/challenges/${encodeURIComponent(challengeId)}/end`,
    body,
    expect: [200],
  });
}

/**
 * Append more sessions to the plan that is already running.
 *
 * Deliberately NOT `startNextBlock`: nothing ends, no baseline is retested, and the challenge
 * keeps its identity — so every workout already recorded against it stays exactly where it is.
 * The command carries the challenge only so its `patternParams` can record the extension; the
 * server refuses it if anything else about the challenge has moved.
 */
export function extendChallenge(
  challengeId: string,
  body: {
    expectedRevision: number;
    challenge: ChallengeRecord;
    slots: readonly PlanSlotRecord[];
  },
): Promise<CommandResult & { appended: number }> {
  return request({
    method: 'POST',
    path: `/challenges/${encodeURIComponent(challengeId)}/extend`,
    body,
    expect: [201],
  });
}

export function startNextBlock(body: {
  expectedRevision: number;
  previousChallengeId: string;
  endedAt: string;
  performanceTest?: PerformanceTest;
  challenge: ChallengeRecord;
  slots: readonly PlanSlotRecord[];
}): Promise<CommandResult> {
  return request({ method: 'POST', path: '/challenges/next-block', body, expect: [201] });
}

export function commitImport(body: {
  expectedRevision: number;
  exercise: ExerciseRecord;
  challenge: ChallengeRecord;
  slots: readonly PlanSlotRecord[];
  workouts: readonly WorkoutRecord[];
  select?: boolean;
}): Promise<CommandResult & { workoutCount: number }> {
  return request({ method: 'POST', path: '/import', body, expect: [201] });
}

/**
 * Patch the settings row.
 *
 * `null` clears a field and an absent key leaves it alone — JSON has no `undefined`, so the
 * read-merge-write the browser used to do needs a spelling for "remove this"
 * (`server/routes.ts:665-672`). `undefined` in the patch object is translated to `null` here so
 * callers can keep writing `{restOverrideSeconds: undefined}` and mean it.
 */
export function patchSettings(
  patch: Partial<Record<keyof SettingsRecord, unknown>>,
  expectedRevision: number,
): Promise<{ snapshot: Snapshot }> {
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id') continue;
    wire[key] = value === undefined ? null : value;
  }
  return request({
    method: 'PATCH',
    path: '/settings',
    body: { expectedRevision, patch: wire },
    expect: [200],
  });
}
