// @vitest-environment node
//
// `POST /api/challenges/:id/pace`, driven against a real database over real HTTP.
//
// This is the second command that writes to a challenge with history behind it, and the first
// that rewrites a slot rather than appending one. Most of what follows is adversarial: the
// endpoint is asked to do the things it must refuse, one at a time, and the stored plan is read
// back afterwards to prove it refused them rather than merely reporting an error.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGodmodeServer, type RunningServer } from './index.js';
import { SESSION_COOKIE } from './session.js';
import type { Snapshot } from './routes.js';

const TOKEN = 'a-token-long-enough-to-be-accepted';

interface Harness {
  base: string;
  cookie: string;
  running: RunningServer;
}

const open: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (open.length > 0) {
    const h = open.pop();
    if (h !== undefined) await h.running.close();
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

async function start(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-repace-'));
  dirs.push(dir);
  const staticRoot = join(dir, 'static');
  mkdirSync(staticRoot);
  const running = createGodmodeServer({ dataDir: dir, staticRoot, token: TOKEN });
  await new Promise<void>((done) => {
    running.server.listen(0, '127.0.0.1', done);
  });
  const address = running.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  const base = `http://127.0.0.1:${String(address.port)}`;

  const login = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = /godmode_session=([^;]*)/.exec(login.headers.getSetCookie()[0] ?? '')?.[1] ?? '';
  const harness: Harness = { base, cookie, running };
  open.push(harness);
  return harness;
}

async function send(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${h.cookie}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) };
}

const snapshot = async (h: Harness): Promise<Snapshot> =>
  (await send(h, 'GET', '/api/snapshot')).body as unknown as Snapshot;

/** A three-session challenge, which is all these tests need. */
async function seed(h: Harness): Promise<{ challengeId: string; revision: number }> {
  const now = '2026-09-08T10:00:00.000Z';
  const challengeId = 'ch_pace';
  const slots = [1, 2, 3].map((ordinal) => ({
    id: `slot_${String(ordinal)}`,
    challengeId,
    ordinal,
    week: 1,
    day: ordinal,
    patternId: 'percentage-ramp',
    patternVersion: 1,
    generatedAt: now,
    targets: [
      { index: 1, targetKind: 'reps', reps: 10 * ordinal, role: 'medium', isAmrap: false },
      { index: 2, targetKind: 'reps', reps: 5 * ordinal, role: 'amrap', isAmrap: true },
    ],
    targetTotal: 15 * ordinal,
    restSeconds: 60,
    status: 'available',
  }));

  const reply = await send(h, 'POST', '/api/challenges', {
    expectedRevision: (await snapshot(h)).revision,
    select: true,
    exercise: { id: 'ex_1', label: 'Push-ups', unit: 'reps', createdAt: now },
    performanceTest: {
      id: 'pt_1',
      exerciseId: 'ex_1',
      challengeId,
      performedAt: now,
      protocolId: 'single-set-max-v1',
      protocolVersion: 1,
      value: 18,
      unit: 'reps',
    },
    challenge: {
      id: challengeId,
      exerciseId: 'ex_1',
      chainId: 'chain_1',
      startedAt: now,
      status: 'active',
      baseline: { value: 18, source: 'tested', evidenceId: 'pt_1', recordedAt: now },
      goalValue: 100,
      patternId: 'percentage-ramp',
      patternVersion: 1,
      patternParams: { baselineMax: 18, goalMax: 100, weeks: 1, daysPerWeek: 3 },
      restPolicyId: 'ramp-rest',
      restPolicyVersion: 1,
      restPolicyParams: { baseSeconds: 60 },
      evaluationPolicyId: 'total-reps',
      evaluationPolicyVersion: 1,
    },
    slots,
  });
  expect(reply.status).toBe(201);
  return { challengeId, revision: (reply.body['snapshot'] as Snapshot).revision };
}

/** A replacement for `ordinal`, priced at `total`, superseding `slot_<ordinal>`. */
function replacement(challengeId: string, ordinal: number, total: number) {
  return {
    id: `slot_${String(ordinal)}_v2`,
    challengeId,
    ordinal,
    week: 1,
    day: ordinal,
    patternId: 'percentage-ramp',
    patternVersion: 1,
    generatedAt: '2026-09-08T11:00:00.000Z',
    targets: [
      { index: 1, targetKind: 'reps', reps: total - 5, role: 'medium', isAmrap: false },
      { index: 2, targetKind: 'reps', reps: 5, role: 'amrap', isAmrap: true },
    ],
    targetTotal: total,
    restSeconds: 60,
    status: 'available',
    supersedesId: `slot_${String(ordinal)}`,
  };
}

const paced = (challengeId: string, snap: Snapshot, pace: unknown) => {
  const challenge = snap.challenges.find((c) => c.id === challengeId)!;
  return {
    ...challenge,
    patternParams: { ...challenge.patternParams, adaptivePace: pace },
  };
};

const PACE = { units: 1.4, step: 0.7, recent: [0.95] };

describe('re-pacing the sessions ahead', () => {
  it('replaces an available slot and records the new pace', async () => {
    const h = await start();
    const { challengeId } = await seed(h);
    const snap = await snapshot(h);

    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: snap.revision,
      challenge: paced(challengeId, snap, PACE),
      slots: [replacement(challengeId, 2, 22), replacement(challengeId, 3, 30)],
    });
    expect(reply.status).toBe(200);
    expect(reply.body['repaced']).toBe(2);

    const after = await snapshot(h);
    const live = after.planSlots.filter(
      (s) => s.challengeId === challengeId && s.status !== 'superseded',
    );
    expect(live.map((s) => s.ordinal).sort()).toEqual([1, 2, 3]);
    expect(live.find((s) => s.ordinal === 2)?.targetTotal).toBe(22);
    expect(live.find((s) => s.ordinal === 3)?.targetTotal).toBe(30);
    // Session 1 was never mentioned and is untouched.
    expect(live.find((s) => s.ordinal === 1)?.targetTotal).toBe(15);

    const old = after.planSlots.find((s) => s.id === 'slot_2');
    expect(old?.status).toBe('superseded');
    expect(after.challenges.find((c) => c.id === challengeId)?.patternParams['adaptivePace'])
      .toEqual(PACE);
  });

  it('REFUSES to re-price a session that has already been trained', async () => {
    const h = await start();
    const { challengeId } = await seed(h);

    // Perform session 1.
    const w = await send(h, 'POST', '/api/workouts', {
      workout: {
        id: 'w_1',
        challengeId,
        chainId: 'chain_1',
        planSlotId: 'slot_1',
        performedAt: '2026-09-08T10:30:00.000Z',
        sets: [
          { index: 1, actual: 10, effectiveTarget: 10 },
          { index: 2, actual: 9, effectiveTarget: 5 },
        ],
        actualTotal: 19,
        adjustmentType: 'none',
        effectiveTotal: 15,
        outcome: 'completed_as_planned',
        evaluation: {
          satisfied: true,
          advances: true,
          reason: 'total met the target',
          measured: { actualTotal: 19, targetTotal: 15 },
        },
      },
    });

    expect(w.status).toBe(201);
    const snap = await snapshot(h);
    const before = snap.planSlots.find((s) => s.id === 'slot_1');
    expect(before?.status).toBe('completed');

    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: snap.revision,
      challenge: paced(challengeId, snap, PACE),
      slots: [replacement(challengeId, 1, 99)],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('session_already_started');

    const after = await snapshot(h);
    expect(after.revision).toBe(snap.revision);
    expect(after.planSlots.find((s) => s.id === 'slot_1')).toEqual(before);
    expect(after.planSlots.some((s) => s.id === 'slot_1_v2')).toBe(false);
  });

  it('records the pace with nothing ahead to change, which is how the mode is switched on', async () => {
    const h = await start();
    const { challengeId } = await seed(h);
    const snap = await snapshot(h);

    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: snap.revision,
      challenge: paced(challengeId, snap, PACE),
      slots: [],
    });
    expect(reply.status).toBe(200);
    expect(reply.body['repaced']).toBe(0);

    const after = await snapshot(h);
    expect(after.challenges.find((c) => c.id === challengeId)?.patternParams['adaptivePace'])
      .toEqual(PACE);
    // Every session is exactly where it was.
    expect(after.planSlots.filter((s) => s.status === 'available')).toHaveLength(3);
  });

  it('refuses to move a session to a different ordinal', async () => {
    const h = await start();
    const { challengeId } = await seed(h);
    const snap = await snapshot(h);

    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: snap.revision,
      challenge: paced(challengeId, snap, PACE),
      slots: [{ ...replacement(challengeId, 2, 22), ordinal: 7 }],
    });
    expect(reply.status).toBe(422);
    expect(reply.body['error']).toBe('slot_moved');
    expect((await snapshot(h)).revision).toBe(snap.revision);
  });

  it('refuses a slot that supersedes nothing, because that would be an append', async () => {
    const h = await start();
    const { challengeId } = await seed(h);
    const snap = await snapshot(h);
    const orphan = replacement(challengeId, 2, 22);
    delete (orphan as Record<string, unknown>)['supersedesId'];

    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: snap.revision,
      challenge: paced(challengeId, snap, PACE),
      slots: [orphan],
    });
    expect(reply.status).toBe(422);
    expect(reply.body['error']).toBe('slot_supersedes_nothing');
  });

  it('refuses to rewrite the parameters a plan regenerates from', async () => {
    const h = await start();
    const { challengeId } = await seed(h);
    const snap = await snapshot(h);
    const challenge = snap.challenges.find((c) => c.id === challengeId)!;

    for (const tamper of [
      { goalMax: 40 },
      { baselineMax: 5 },
      { weeks: 9 },
      { daysPerWeek: 6 },
      { extraSessions: 3 },
    ]) {
      const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
        expectedRevision: snap.revision,
        challenge: {
          ...challenge,
          patternParams: { ...challenge.patternParams, adaptivePace: PACE, ...tamper },
        },
        slots: [replacement(challengeId, 2, 22)],
      });
      expect(reply.status).toBe(409);
      expect(reply.body['error']).toBe('pattern_params_changed');
    }

    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: snap.revision,
      challenge: { ...paced(challengeId, snap, PACE), goalValue: 12 },
      slots: [replacement(challengeId, 2, 22)],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('challenge_changed');
    expect((await snapshot(h)).revision).toBe(snap.revision);
  });

  it('answers a stale revision with 409 and the current state', async () => {
    const h = await start();
    const { challengeId } = await seed(h);
    const snap = await snapshot(h);

    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: snap.revision - 1,
      challenge: paced(challengeId, snap, PACE),
      slots: [replacement(challengeId, 2, 22)],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['snapshot']).toBeDefined();
  });

  it('refuses two arriving slots that replace the same session', async () => {
    const h = await start();
    const { challengeId } = await seed(h);
    const snap = await snapshot(h);

    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: snap.revision,
      challenge: paced(challengeId, snap, PACE),
      slots: [
        replacement(challengeId, 2, 22),
        { ...replacement(challengeId, 2, 25), id: 'slot_2_v3' },
      ],
    });
    expect(reply.status).toBe(422);
    expect(reply.body['error']).toBe('duplicate_supersede');
  });

  it('refuses to supersede a slot that was already superseded', async () => {
    const h = await start();
    const { challengeId } = await seed(h);

    const first = await snapshot(h);
    await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: first.revision,
      challenge: paced(challengeId, first, PACE),
      slots: [replacement(challengeId, 2, 22)],
    });

    const second = await snapshot(h);
    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: second.revision,
      challenge: paced(challengeId, second, PACE),
      slots: [{ ...replacement(challengeId, 2, 30), id: 'slot_2_v3' }],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('session_already_started');
  });

  it('leaves the plan whole when one slot in a batch is bad', async () => {
    const h = await start();
    const { challengeId } = await seed(h);
    const snap = await snapshot(h);

    const reply = await send(h, 'POST', `/api/challenges/${challengeId}/pace`, {
      expectedRevision: snap.revision,
      challenge: paced(challengeId, snap, PACE),
      slots: [
        replacement(challengeId, 2, 22),
        { ...replacement(challengeId, 3, 30), supersedesId: 'slot_nope' },
      ],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('unknown_slot');

    // The good half of the batch must not have landed: one transaction, all or nothing.
    const after = await snapshot(h);
    expect(after.revision).toBe(snap.revision);
    expect(after.planSlots.find((s) => s.id === 'slot_2')?.status).toBe('available');
    expect(after.planSlots.some((s) => s.id === 'slot_2_v2')).toBe(false);
  });
});
