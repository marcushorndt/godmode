// @vitest-environment node
//
// The real plan, the real server, the real file: "Add another week" end to end.
//
// The unit tests either exercise the generator with no database behind it, or the endpoint with
// hand-written slots that are not a real plan. Neither of them can catch the failure this feature
// is most dangerous for — an extension that changes the prescription of a session already
// performed — because that failure only shows up when the *real* eighteen slots are in SQLite,
// with workouts pointing at them, and the extension is composed by the same builder the app uses.
//
// So this test drives `buildChallenge` → `POST /api/challenges` → eighteen finished workouts →
// `buildExtension` → `POST /api/challenges/:id/extend`, and compares every stored slot before and
// after, byte for byte.
//
// It imports `src/db/records.ts` deliberately. That module pulls `idb` in through the schema's
// type home — harmless in a test process, and the alternative (a hand-copied plan) would prove
// nothing about the code the owner actually runs.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGodmodeServer, type RunningServer } from './index.js';
import { SESSION_COOKIE } from './session.js';
import type { Snapshot } from './routes.js';
import { pushupParams } from '../src/core/patterns/percentageRamp.js';
import { buildChallenge, buildExtension, buildWorkout } from '../src/db/records.js';
import { DEFAULT_SETTINGS, type PlanSlotRecord } from '../src/db/schema.js';

const TOKEN = 'a-token-long-enough-to-be-accepted';

const running: RunningServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

/** A signed-in client against a server with its own scratch data directory. */
async function signedIn(): Promise<(method: string, path: string, body?: unknown) => Promise<{
  status: number;
  body: Record<string, unknown>;
}>> {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-extend-'));
  dirs.push(dir);
  const staticRoot = join(dir, 'static');
  mkdirSync(staticRoot);

  const server = createGodmodeServer({
    dataDir: dir,
    staticRoot,
    token: TOKEN,
    now: () => Date.UTC(2026, 6, 31, 8, 0, 0),
  });
  running.push(server);
  await new Promise<void>((done) => {
    server.server.listen(0, '127.0.0.1', done);
  });
  const address = server.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  const base = `http://127.0.0.1:${String(address.port)}`;

  let cookie: string | undefined;
  const send = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers['cookie'] = `${SESSION_COOKIE}=${cookie}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const raw of response.headers.getSetCookie()) {
      const match = /^godmode_session=([^;]*)/.exec(raw);
      if (match !== null) cookie = match[1] === '' ? undefined : match[1];
    }
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  };

  const login = await send('POST', '/api/session', { token: TOKEN });
  expect(login.status).toBe(200);
  return send;
}

function snapshotOf(reply: { body: Record<string, unknown> }): Snapshot {
  return reply.body['snapshot'] as unknown as Snapshot;
}

function slotsOrdered(snapshot: Snapshot): PlanSlotRecord[] {
  return [...snapshot.planSlots].sort((a, b) => a.ordinal - b.ordinal);
}

describe("the owner's real challenge, extended", () => {
  it('appends week 7 without moving a single one of the eighteen sessions behind it', async () => {
    const send = await signedIn();

    // 1. The real plan the app generates: baseline 18, goal 100, six weeks of three.
    const { challenge, slots } = buildChallenge({
      exerciseId: 'ex_pushups',
      params: pushupParams(18, 100),
      baseline: { value: 18, source: 'tested', recordedAt: '2026-05-29T08:00:00.000Z' },
    });
    expect(slots).toHaveLength(18);
    expect(slots[17]?.targetTotal).toBe(205);

    const created = await send('POST', '/api/challenges', {
      expectedRevision: 0,
      exercise: {
        id: 'ex_pushups',
        label: 'Push-ups',
        unit: 'reps',
        createdAt: '2026-05-29T08:00:00.000Z',
      },
      challenge,
      slots,
      select: true,
    });
    expect(created.status).toBe(201);

    // 2. Train all eighteen of them, so every slot is `completed` and carries a workout.
    let snapshot = snapshotOf(created);
    for (const slot of slots) {
      const targets = slot.targets.map((t) => t.reps);
      const { workout } = buildWorkout({
        workoutId: `wo_${String(slot.ordinal)}`,
        challenge,
        slot,
        performance: {
          sets: targets.map((reps, i) => ({ index: i + 1, effectiveTarget: reps, actual: reps })),
          actualTotal: slot.targetTotal,
          adjustmentType: 'none',
          effectiveTotal: slot.targetTotal,
        },
        performedAt: `2026-06-${String(slot.ordinal).padStart(2, '0')}T07:00:00.000Z`,
        settings: DEFAULT_SETTINGS,
      });
      const logged = await send('POST', '/api/workouts', { workout });
      expect(logged.status).toBe(201);
      snapshot = snapshotOf(logged);
    }
    const before = slotsOrdered(snapshot);
    expect(before).toHaveLength(18);
    expect(before.every((slot) => slot.status === 'completed')).toBe(true);
    expect(snapshot.workouts).toHaveLength(18);

    // 3. Extend, exactly as the app composes it.
    const extension = buildExtension({
      challenge: snapshot.challenges[0]!,
      existingSlots: before,
    });
    const extended = await send('POST', `/api/challenges/${challenge.id}/extend`, {
      expectedRevision: snapshot.revision,
      challenge: extension.challenge,
      slots: extension.slots,
    });
    expect(extended.status).toBe(201);

    const after = slotsOrdered(snapshotOf(extended));
    expect(after).toHaveLength(21);

    // 4. The property the whole design exists for: the eighteen sessions already performed come
    //    back out of SQLite byte-identical, and only new ordinals appeared.
    expect(after.slice(0, 18)).toEqual(before);
    expect(after.slice(18).map((slot) => slot.ordinal)).toEqual([19, 20, 21]);

    // 5. And the numbers the owner was shown.
    expect(after.slice(18).map((slot) => slot.targetTotal)).toEqual([216, 227, 238]);
    expect(after[18]?.targets.map((t) => t.reps)).toEqual([39, 49, 39, 35, 54]);
    expect(after.slice(18).map((slot) => [slot.week, slot.day])).toEqual([
      [7, 1],
      [7, 2],
      [7, 3],
    ]);
    expect(after.slice(18).every((slot) => slot.status === 'available')).toBe(true);

    // The history is untouched, and the challenge is still the same active challenge.
    expect(snapshotOf(extended).workouts).toEqual(snapshot.workouts);
    expect(snapshotOf(extended).challenges).toHaveLength(1);
    expect(snapshotOf(extended).challenges[0]?.status).toBe('active');
    expect(snapshotOf(extended).challenges[0]?.patternParams['extraSessions']).toBe(3);
    expect(snapshotOf(extended).challenges[0]?.patternParams['weeks']).toBe(6);

    // 6. Train the appended week, then extend again: k keeps counting up, so the second block
    //    continues past 238 rather than starting over from the goal.
    let trained = snapshotOf(extended);
    for (const slot of after.slice(18)) {
      const targets = slot.targets.map((t) => t.reps);
      const { workout } = buildWorkout({
        workoutId: `wo_${String(slot.ordinal)}`,
        challenge: trained.challenges[0]!,
        slot,
        performance: {
          sets: targets.map((reps, i) => ({ index: i + 1, effectiveTarget: reps, actual: reps })),
          actualTotal: slot.targetTotal,
          adjustmentType: 'none',
          effectiveTotal: slot.targetTotal,
        },
        performedAt: `2026-07-${String(slot.ordinal).padStart(2, '0')}T07:00:00.000Z`,
        settings: DEFAULT_SETTINGS,
      });
      const logged = await send('POST', '/api/workouts', { workout });
      expect(logged.status).toBe(201);
      trained = snapshotOf(logged);
    }

    const again = buildExtension({
      challenge: trained.challenges[0]!,
      existingSlots: slotsOrdered(trained),
    });
    const twice = await send('POST', `/api/challenges/${challenge.id}/extend`, {
      expectedRevision: trained.revision,
      challenge: again.challenge,
      slots: again.slots,
    });
    expect(twice.status).toBe(201);

    const final = slotsOrdered(snapshotOf(twice));
    expect(final).toHaveLength(24);
    expect(final.slice(0, 21)).toEqual(slotsOrdered(trained));
    expect(final.slice(21).map((slot) => slot.targetTotal)).toEqual([250, 264, 278]);
    expect(final.slice(21).map((slot) => [slot.week, slot.day])).toEqual([
      [8, 1],
      [8, 2],
      [8, 3],
    ]);
  });
});
