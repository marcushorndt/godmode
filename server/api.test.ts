// @vitest-environment node
//
// The API, driven for real: a real `node:sqlite` database in a temporary directory, a real
// `node:http` listener on port 0, and real `fetch` requests carrying real cookies. Nothing is
// mocked, because the three properties this step exists to establish — idempotency, the
// revision/409 scheme, and the slot ratchet — are all properties of what SQLite and the HTTP
// layer actually do under concurrency, not of what a stub agrees to.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptLimiter } from './auth.js';
import { clone, MINIMAL_BACKUP } from './fixtures.js';
import {
  assertNodeVersion,
  createGodmodeServer,
  nodeMajor,
  nodeVersionIsSupported,
  resolveBindHost,
  resolvePort,
  type RunningServer,
} from './index.js';
import { API_VERSION, ratchet, type Snapshot } from './routes.js';
import { SESSION_COOKIE, SessionStore } from './session.js';

const TOKEN = 'a-token-long-enough-to-be-accepted';

interface Harness {
  readonly base: string;
  readonly running: RunningServer;
  readonly dir: string;
  readonly staticRoot: string;
  setNow: (ms: number) => void;
}

const open: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop();
    if (harness !== undefined) await harness.running.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function start(options: { limiter?: AttemptLimiter; sessions?: SessionStore } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-api-'));
  dirs.push(dir);
  const staticRoot = join(dir, 'static');
  mkdirSync(staticRoot);

  let now = Date.UTC(2026, 6, 30, 12, 0, 0);
  const running = createGodmodeServer({
    dataDir: dir,
    staticRoot,
    token: TOKEN,
    now: () => now,
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
  });
  await new Promise<void>((done) => {
    running.server.listen(0, '127.0.0.1', done);
  });
  const address = running.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');

  const harness: Harness = {
    base: `http://127.0.0.1:${String(address.port)}`,
    running,
    dir,
    staticRoot,
    setNow: (ms) => {
      now = ms;
    },
  };
  open.push(harness);
  return harness;
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly setCookie: readonly string[];
}

/** A browser-shaped client: one cookie jar, sent back exactly as a browser would. */
class Client {
  cookie: string | undefined;
  readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  async send(
    method: string,
    path: string,
    body?: unknown,
    init: { raw?: string; contentType?: string | null } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = {};
    if (this.cookie !== undefined) headers['cookie'] = `${SESSION_COOKIE}=${this.cookie}`;
    let payload: string | undefined;
    if (init.raw !== undefined) payload = init.raw;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (payload !== undefined) {
      const type = init.contentType === undefined ? 'application/json' : init.contentType;
      if (type !== null) headers['content-type'] = type;
    }

    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    });

    const setCookie = response.headers.getSetCookie();
    for (const raw of setCookie) {
      const match = /^godmode_session=([^;]*)/.exec(raw);
      if (match === null) continue;
      this.cookie = match[1] === '' ? undefined : match[1];
    }

    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      headers: response.headers,
      setCookie,
    };
  }

  async login(token = TOKEN): Promise<Reply> {
    return this.send('POST', '/api/session', { token });
  }

  async snapshot(): Promise<Snapshot> {
    const reply = await this.send('GET', '/api/snapshot');
    if (reply.status !== 200) throw new Error(`snapshot failed: ${String(reply.status)}`);
    return reply.body as unknown as Snapshot;
  }
}

function snapshotOf(reply: Reply): Snapshot {
  return reply.body['snapshot'] as unknown as Snapshot;
}

// ── Fixture-derived commands ────────────────────────────────────────────────────────────────

function exerciseRecord(): unknown {
  return clone(MINIMAL_BACKUP.exercises[0]);
}
function challengeRecord(): Record<string, unknown> {
  return clone(MINIMAL_BACKUP.challenges[0]) as unknown as Record<string, unknown>;
}
function slotRecord(): Record<string, unknown> {
  return clone(MINIMAL_BACKUP.planSlots[0]) as unknown as Record<string, unknown>;
}

/** A finished workout as the client composes it: its own id, and no `attemptNo`. */
function workoutCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wo_new',
    challengeId: 'ch_1',
    chainId: 'ch_1',
    planSlotId: 'slot_1',
    performedAt: '2026-07-30T09:00:00.000Z',
    sets: [{ index: 1, actual: 20 }],
    actualTotal: 20,
    adjustmentType: 'none',
    outcome: 'completed_as_planned',
    evaluation: {
      satisfied: true,
      advances: true,
      reason: 'total reps met the prescription',
      measured: { actualTotal: 20, targetTotal: 0 },
    },
    evaluationPolicyId: 'total-reps-at-least-target',
    evaluationPolicyVersion: 1,
    ...overrides,
  };
}

/** Sign in and seed one exercise, one active challenge and one available slot. */
async function seeded(harness: Harness): Promise<{ client: Client; revision: number }> {
  const client = new Client(harness.base);
  await client.login();
  const created = await client.send('POST', '/api/challenges', {
    expectedRevision: 0,
    exercise: exerciseRecord(),
    challenge: challengeRecord(),
    slots: [slotRecord()],
    select: true,
  });
  expect(created.status).toBe(201);
  return { client, revision: snapshotOf(created).revision };
}

// ── Authentication ──────────────────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('refuses every data endpoint without a session', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    for (const [method, path] of [
      ['GET', '/api/snapshot'],
      ['POST', '/api/workouts'],
      ['POST', '/api/challenges'],
      ['POST', '/api/import'],
      ['PATCH', '/api/settings'],
    ] as const) {
      const reply = await client.send(method, path, method === 'GET' ? undefined : {});
      expect(reply.status).toBe(401);
      expect(reply.body['error']).toBe('unauthenticated');
    }
  });

  it('exchanges the token for an HttpOnly, Secure, SameSite=Strict cookie', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    const reply = await client.login();
    expect(reply.status).toBe(200);
    const cookie = reply.setCookie.find((value) => value.startsWith(SESSION_COOKIE));
    expect(cookie).toBeDefined();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect((await client.snapshot()).apiVersion).toBe(API_VERSION);
  });

  it('rejects a wrong token without echoing any part of it', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    const reply = await client.login('not-the-token-but-long-enough');
    expect(reply.status).toBe(401);
    expect(JSON.stringify(reply.body)).not.toContain('not-the-token');
    expect(JSON.stringify(reply.body)).not.toContain(TOKEN);
    expect(reply.setCookie).toHaveLength(0);
  });

  it('rate-limits guessing and says how long to wait', async () => {
    const harness = await start({ limiter: new AttemptLimiter({ maxFailures: 3, windowMs: 60_000 }) });
    const client = new Client(harness.base);
    for (let i = 0; i < 3; i += 1) {
      expect((await client.login('wrong-but-long-enough-token')).status).toBe(401);
    }
    const blocked = await client.login('wrong-but-long-enough-token');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // And the correct token is refused too while the window is open — otherwise the limit is
    // no limit at all for whoever eventually guesses right.
    expect((await client.login()).status).toBe(429);
  });

  it('mints a new session on every sign-in and abandons the one presented', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const first = client.cookie;
    await client.login();
    expect(client.cookie).not.toBe(first);

    const stale = new Client(harness.base);
    stale.cookie = first;
    expect((await stale.send('GET', '/api/snapshot')).status).toBe(401);
  });

  it('never adopts a session id it did not mint', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    client.cookie = 'forged-session-identifier';
    expect((await client.send('GET', '/api/snapshot')).status).toBe(401);
  });

  it('signs out server-side, not only in the browser', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const id = client.cookie;
    const out = await client.send('DELETE', '/api/session');
    expect(out.status).toBe(204);
    expect(out.setCookie.join(' ')).toContain('Max-Age=0');

    // Replay the cookie the browser was told to drop: the server must refuse it anyway.
    const replay = new Client(harness.base);
    replay.cookie = id;
    expect((await replay.send('GET', '/api/snapshot')).status).toBe(401);
  });

  it('expires a session and reports it as unauthenticated', async () => {
    const harness = await start({ sessions: new SessionStore({ maxAgeMs: 1000, idleMs: 1000 }) });
    const client = new Client(harness.base);
    await client.login();
    expect((await client.send('GET', '/api/session')).body['authenticated']).toBe(true);
    harness.setNow(Date.UTC(2026, 6, 30, 12, 0, 0) + 5000);
    expect((await client.send('GET', '/api/session')).body['authenticated']).toBe(false);
    expect((await client.send('GET', '/api/snapshot')).status).toBe(401);
  });
});

// ── Routing and request hygiene ─────────────────────────────────────────────────────────────

describe('routing', () => {
  it('answers an unknown API route with JSON, never with the app shell', async () => {
    const harness = await start();
    writeFileSync(join(harness.staticRoot, 'index.html'), '<p>shell</p>');
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('GET', '/api/nope');
    expect(reply.status).toBe(404);
    expect(reply.body['error']).toBe('unknown_route');
    expect(reply.headers.get('content-type')).toContain('application/json');
  });

  it('rejects the wrong method on a known route', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    expect((await client.send('DELETE', '/api/snapshot')).status).toBe(405);
    expect((await client.send('POST', '/api/settings', {})).status).toBe(405);
  });

  it('bounds the request body', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('POST', '/api/workouts', undefined, {
      raw: JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(reply.status).toBe(413);
  });

  it('requires JSON, and valid JSON', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    expect(
      (await client.send('PATCH', '/api/settings', undefined, { raw: 'x', contentType: 'text/plain' }))
        .status,
    ).toBe(415);
    expect(
      (await client.send('PATCH', '/api/settings', undefined, { raw: '{oops' })).status,
    ).toBe(400);
  });

  it('sends a strict Content-Security-Policy on every response', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    const reply = await client.send('GET', '/api/session');
    const csp = reply.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(reply.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('never lets an API response be cached', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    expect((await client.send('GET', '/api/snapshot')).headers.get('cache-control')).toBe(
      'no-store',
    );
  });
});

describe('the static shell', () => {
  it('serves the built app and falls back to index.html for client routes', async () => {
    const harness = await start();
    writeFileSync(join(harness.staticRoot, 'index.html'), '<p>shell</p>');
    mkdirSync(join(harness.staticRoot, 'assets'));
    writeFileSync(join(harness.staticRoot, 'assets', 'app-abc123.js'), 'export {}');

    // Every body is read: an undrained response holds its connection open, and the cost lands
    // on whatever runs next rather than here.
    const asset = await fetch(`${harness.base}/assets/app-abc123.js`);
    expect(await asset.text()).toBe('export {}');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    const route = await fetch(`${harness.base}/history`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('shell');

    const shell = await fetch(`${harness.base}/`);
    expect(await shell.text()).toContain('shell');
    expect(shell.headers.get('cache-control')).toBe('no-cache');
  });

  it('refuses to serve anything outside the static root', async () => {
    const harness = await start();
    writeFileSync(join(harness.staticRoot, 'index.html'), '<p>shell</p>');
    writeFileSync(join(harness.dir, 'godmode.sqlite.secret'), 'not yours');
    const escaped = await fetch(`${harness.base}/../godmode.sqlite.secret`);
    expect(await escaped.text()).toContain('shell');
    const encoded = await fetch(`${harness.base}/%2e%2e%2fgodmode.sqlite.secret`);
    expect(await encoded.text()).toContain('shell');
  });

  it('refuses to follow a symlink out of the static root', async () => {
    // Containment is lexical, and `stat` follows symlinks — so a link inside the served tree
    // would pass the path check and then be read from its target. `lstat` closes that.
    const harness = await start();
    writeFileSync(join(harness.staticRoot, 'index.html'), '<p>shell</p>');
    writeFileSync(join(harness.dir, 'outside.txt'), 'not yours');
    symlinkSync(join(harness.dir, 'outside.txt'), join(harness.staticRoot, 'link.txt'));

    const linked = await fetch(`${harness.base}/link.txt`);
    const body = await linked.text();
    expect(body).not.toContain('not yours');
    expect(body).toContain('shell');
  });
});

// ── The snapshot ────────────────────────────────────────────────────────────────────────────

describe('GET /api/snapshot', () => {
  it('returns an empty dataset with defaults and revision 0', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const snapshot = await client.snapshot();
    expect(snapshot).toMatchObject({
      apiVersion: API_VERSION,
      schemaVersion: 1,
      revision: 0,
      exercises: [],
      challenges: [],
      planSlots: [],
      workouts: [],
      performanceTests: [],
      settings: { id: 'settings', kcalCoefficient: 0.003 },
    });
  });

  it('orders workouts by when they were performed, not by attempt number', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    // Accepted second, performed first: display order must follow performed_at.
    await client.send('POST', '/api/workouts', {
      workout: workoutCommand({ id: 'wo_later', performedAt: '2026-07-30T18:00:00.000Z' }),
    });
    const second = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({ id: 'wo_earlier', performedAt: '2026-07-30T06:00:00.000Z' }),
    });
    expect(revision).toBe(1);
    const workouts = snapshotOf(second).workouts;
    expect(workouts.map((w) => w.id)).toEqual(['wo_earlier', 'wo_later']);
    expect(workouts.map((w) => w.attemptNo)).toEqual([2, 1]);
  });
});

// ── Appending workouts ──────────────────────────────────────────────────────────────────────

describe('POST /api/workouts', () => {
  it('assigns attempt numbers as an acceptance sequence', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const first = await client.send('POST', '/api/workouts', { workout: workoutCommand({ id: 'w1' }) });
    const second = await client.send('POST', '/api/workouts', { workout: workoutCommand({ id: 'w2' }) });
    expect(first.body['attemptNo']).toBe(1);
    expect(second.body['attemptNo']).toBe(2);
  });

  it('is idempotent on the client-generated id, in the same transaction', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const first = await client.send('POST', '/api/workouts', { workout: workoutCommand() });
    expect(first.status).toBe(201);
    expect(first.body['duplicate']).toBe(false);
    const revisionAfterFirst = snapshotOf(first).revision;

    // The same command again — a retried POST whose response was lost.
    const retry = await client.send('POST', '/api/workouts', { workout: workoutCommand() });
    expect(retry.body['duplicate']).toBe(true);
    expect(retry.body['attemptNo']).toBe(1);
    expect(retry.body['workout']).toEqual(first.body['workout']);
    // Nothing was recounted, nothing was re-applied, and the revision did not move.
    expect(snapshotOf(retry).revision).toBe(revisionAfterFirst);
    expect(snapshotOf(retry).workouts).toHaveLength(1);
  });

  it('stays idempotent when both copies are genuinely in flight at once', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    // Two overlapping requests, not two sequential ones: this is the shape a reconnect drainer
    // and a page-load drainer produce, and the one a sequential test cannot rule out.
    const [a, b] = await Promise.all([
      client.send('POST', '/api/workouts', { workout: workoutCommand() }),
      client.send('POST', '/api/workouts', { workout: workoutCommand() }),
    ]);
    const duplicates = [a, b].filter((reply) => reply.body['duplicate'] === true);
    expect(duplicates).toHaveLength(1);
    expect(a.body['attemptNo']).toBe(1);
    expect(b.body['attemptNo']).toBe(1);
    const snapshot = await client.snapshot();
    expect(snapshot.workouts).toHaveLength(1);
    // One insert, one revision increment: seeding was 1, the single accepted workout makes 2.
    expect(snapshot.revision).toBe(2);
  });

  it('returns the ORIGINAL stored workout, not the resubmitted body', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    await client.send('POST', '/api/workouts', { workout: workoutCommand({ actualTotal: 20 }) });
    const retry = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({ actualTotal: 999, note: 'rewritten' }),
    });
    expect(retry.body['duplicate']).toBe(true);
    const stored = retry.body['workout'] as Record<string, unknown>;
    expect(stored['actualTotal']).toBe(20);
    expect(Object.hasOwn(stored, 'note')).toBe(false);
  });

  it('refuses a client-supplied attemptNo', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const reply = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({ attemptNo: 7 }),
    });
    expect(reply.status).toBe(400);
    expect(reply.body['error']).toBe('attempt_no_not_accepted');
  });

  it('ratchets the slot to completed and never back down', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const advanced = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({ id: 'w_pass' }),
    });
    expect(snapshotOf(advanced).planSlots[0]?.status).toBe('completed');

    // A late, failed attempt drained from the other device's outbox.
    const failed = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({
        id: 'w_fail',
        outcome: 'failed',
        evaluation: {
          satisfied: false,
          advances: false,
          reason: 'short of the prescription',
          measured: { actualTotal: 3, targetTotal: 0 },
        },
      }),
    });
    expect(failed.status).toBe(201);
    // The workout is kept — performed training is never thrown away — but the day stays cleared.
    expect(snapshotOf(failed).workouts).toHaveLength(2);
    expect(snapshotOf(failed).planSlots[0]?.status).toBe('completed');
  });

  it('marks a slot attempted when the workout did not advance', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const reply = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({
        outcome: 'failed',
        evaluation: {
          satisfied: false,
          advances: false,
          reason: 'short',
          measured: { actualTotal: 3, targetTotal: 0 },
        },
      }),
    });
    expect(snapshotOf(reply).planSlots[0]?.status).toBe('attempted');
  });

  it('accepts an outbox drain composed against a long-stale revision', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    // Move the dataset on, several times, as the other device would.
    for (const coefficient of [0.004, 0.005, 0.006]) {
      const current = (await client.snapshot()).revision;
      await client.send('PATCH', '/api/settings', {
        expectedRevision: current,
        patch: { kcalCoefficient: coefficient },
      });
    }
    // The workout carries no revision at all, and must still land.
    const reply = await client.send('POST', '/api/workouts', { workout: workoutCommand() });
    expect(reply.status).toBe(201);
    expect(snapshotOf(reply).workouts).toHaveLength(1);
  });

  it('still validates the records it references', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const unknownSlot = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({ planSlotId: 'slot_missing' }),
    });
    expect(unknownSlot.status).toBe(409);
    expect(unknownSlot.body['error']).toBe('unknown_plan_slot');
    // A 409 always carries the fresh state, so the client is not left guessing.
    expect(snapshotOf(unknownSlot).revision).toBeGreaterThanOrEqual(0);

    const wrongChain = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({ chainId: 'some_other_chain' }),
    });
    expect(wrongChain.status).toBe(409);
    expect(wrongChain.body['error']).toBe('chain_mismatch');
  });

  it('rejects a workout carrying a property no column can hold', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const reply = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({ mood: 'great' }),
    });
    expect(reply.status).toBe(422);
    expect(JSON.stringify(reply.body['details'])).toContain('mood');
    expect((await client.snapshot()).workouts).toHaveLength(0);
  });

  it('requires a plan slot: unlinked workouts arrive through import, not here', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const command = workoutCommand();
    delete command['planSlotId'];
    expect((await client.send('POST', '/api/workouts', { workout: command })).status).toBe(400);
  });
});

describe('the ratchet, directly', () => {
  it('is a one-way door out of completed, and leaves retired slots alone', () => {
    expect(ratchet('available', true)).toBe('completed');
    expect(ratchet('available', false)).toBe('attempted');
    expect(ratchet('attempted', true)).toBe('completed');
    expect(ratchet('attempted', false)).toBe('attempted');
    expect(ratchet('completed', false)).toBe('completed');
    expect(ratchet('superseded', true)).toBe('superseded');
    expect(ratchet('cancelled', true)).toBe('cancelled');
  });
});

// ── Optimistic concurrency ──────────────────────────────────────────────────────────────────

describe('the revision scheme', () => {
  it('bumps the revision once per accepted command', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    expect((await client.snapshot()).revision).toBe(1);
    const patched = await client.send('PATCH', '/api/settings', {
      expectedRevision: 1,
      patch: { bodyweightKg: 82 },
    });
    expect(snapshotOf(patched).revision).toBe(2);
  });

  it('refuses a stale write and returns fresh state instead of overwriting', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const laptop = new Client(harness.base);
    laptop.cookie = client.cookie;
    const phone = new Client(harness.base);
    phone.cookie = client.cookie;

    const shared = (await laptop.snapshot()).revision;
    const won = await laptop.send('PATCH', '/api/settings', {
      expectedRevision: shared,
      patch: { bodyweightKg: 80 },
    });
    expect(won.status).toBe(200);

    const lost = await phone.send('PATCH', '/api/settings', {
      expectedRevision: shared,
      patch: { bodyweightKg: 95 },
    });
    expect(lost.status).toBe(409);
    expect(lost.body['error']).toBe('revision_conflict');
    // The laptop's write survives, and the phone is handed what it needs to retry.
    expect(snapshotOf(lost).settings.bodyweightKg).toBe(80);
    expect(snapshotOf(lost).revision).toBe(shared + 1);
  });

  it('lets exactly one of two simultaneous writes win', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const shared = (await client.snapshot()).revision;
    const [a, b] = await Promise.all([
      client.send('PATCH', '/api/settings', {
        expectedRevision: shared,
        patch: { bodyweightKg: 80 },
      }),
      client.send('PATCH', '/api/settings', {
        expectedRevision: shared,
        patch: { bodyweightKg: 95 },
      }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const snapshot = await client.snapshot();
    expect(snapshot.revision).toBe(shared + 1);
    expect(snapshot.settings.bodyweightKg).toBe(snapshotOf(winner).settings.bodyweightKg);
  });

  it('requires a revision on every ordinary command', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    for (const [path, body] of [
      ['/api/settings', { patch: {} }],
      ['/api/challenges', { challenge: challengeRecord(), slots: [] }],
      ['/api/import', { exercise: exerciseRecord(), challenge: challengeRecord(), slots: [], workouts: [] }],
    ] as const) {
      const method = path === '/api/settings' ? 'PATCH' : 'POST';
      const reply = await client.send(method, path, body);
      expect(reply.status).toBe(400);
      expect(reply.body['error']).toBe('invalid_revision');
    }
  });

  it('writes nothing at all when the revision check fails', async () => {
    const harness = await start();
    const { client } = await seeded(harness);
    const challenge = { ...challengeRecord(), id: 'ch_2', chainId: 'ch_2' };
    const reply = await client.send('POST', '/api/challenges', {
      expectedRevision: 0,
      challenge,
      slots: [],
    });
    expect(reply.status).toBe(409);
    expect(snapshotOf(reply).challenges.map((c) => c.id)).toEqual(['ch_1']);
  });
});

// ── Challenge lifecycle ─────────────────────────────────────────────────────────────────────

describe('POST /api/challenges', () => {
  it('creates the exercise, the challenge and its plan in one transaction', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('POST', '/api/challenges', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [slotRecord()],
      select: true,
    });
    expect(reply.status).toBe(201);
    const snapshot = snapshotOf(reply);
    expect(snapshot.exercises).toHaveLength(1);
    expect(snapshot.challenges).toHaveLength(1);
    expect(snapshot.planSlots).toHaveLength(1);
    expect(snapshot.settings.selectedChallengeId).toBe('ch_1');
  });

  it('leaves nothing behind when one slot is invalid', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('POST', '/api/challenges', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [slotRecord(), { ...slotRecord(), id: 'slot_2', ordinal: 0 }],
    });
    expect(reply.status).toBe(422);
    const snapshot = await client.snapshot();
    expect(snapshot.exercises).toHaveLength(0);
    expect(snapshot.challenges).toHaveLength(0);
    expect(snapshot.revision).toBe(0);
  });

  it('refuses a slot that names a different challenge', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('POST', '/api/challenges', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [{ ...slotRecord(), challengeId: 'ch_other' }],
    });
    expect(reply.status).toBe(422);
    expect(reply.body['error']).toBe('slot_challenge_mismatch');
  });

  it('refuses a plan that arrives claiming days were already done', async () => {
    // The ratchet only moves forward, so a slot installed as `completed` could never be
    // corrected by any workout. A plan with history behind it belongs in an import.
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('POST', '/api/challenges', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [{ ...slotRecord(), status: 'completed' }],
    });
    expect(reply.status).toBe(422);
    expect(reply.body['error']).toBe('slot_not_fresh');
    expect((await client.snapshot()).planSlots).toHaveLength(0);
  });

  it('refuses a slot that supersedes another, and a challenge that starts ended', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    expect(
      (
        await client.send('POST', '/api/challenges', {
          expectedRevision: 0,
          exercise: exerciseRecord(),
          challenge: challengeRecord(),
          slots: [{ ...slotRecord(), supersedesId: 'slot_0' }],
        })
      ).body['error'],
    ).toBe('slot_not_fresh');
    expect(
      (
        await client.send('POST', '/api/challenges', {
          expectedRevision: 0,
          exercise: exerciseRecord(),
          challenge: { ...challengeRecord(), status: 'ended' },
          slots: [slotRecord()],
        })
      ).body['error'],
    ).toBe('challenge_not_active');
  });

  it('refuses a seeding test for a different exercise', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('POST', '/api/challenges', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [slotRecord()],
      performanceTest: {
        id: 'test_x',
        exerciseId: 'ex_other',
        performedAt: '2026-05-29T07:00:00.000Z',
        protocolId: 'single-set-max-v1',
        protocolVersion: 1,
        value: 18,
        unit: 'reps',
      },
    });
    expect(reply.status).toBe(422);
    expect(reply.body['error']).toBe('test_exercise_mismatch');
  });

  it('refuses to overwrite an id that already holds different content', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    const reply = await client.send('POST', '/api/challenges', {
      expectedRevision: revision,
      challenge: { ...challengeRecord(), goalValue: 999 },
      slots: [],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('record_conflict');
    expect(snapshotOf(reply).challenges[0]).not.toHaveProperty('goalValue');
  });
});

describe('POST /api/challenges/:id/end', () => {
  it('ends an active challenge', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    const reply = await client.send('POST', '/api/challenges/ch_1/end', {
      expectedRevision: revision,
      endReason: 'closed_manually',
      endedAt: '2026-07-30T20:00:00.000Z',
    });
    expect(reply.status).toBe(200);
    expect(snapshotOf(reply).challenges[0]).toMatchObject({
      status: 'ended',
      endReason: 'closed_manually',
      endedAt: '2026-07-30T20:00:00.000Z',
    });
  });

  it('refuses to end it twice, rather than rewriting when it ended and why', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    await client.send('POST', '/api/challenges/ch_1/end', {
      expectedRevision: revision,
      endReason: 'closed_manually',
      endedAt: '2026-07-30T20:00:00.000Z',
    });
    const again = await client.send('POST', '/api/challenges/ch_1/end', {
      expectedRevision: revision + 1,
      endReason: 'abandoned',
      endedAt: '2026-07-31T20:00:00.000Z',
    });
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('already_ended');
    expect(snapshotOf(again).challenges[0]?.endReason).toBe('closed_manually');
  });

  it('rejects an end reason outside the closed set', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    const reply = await client.send('POST', '/api/challenges/ch_1/end', {
      expectedRevision: revision,
      endReason: 'because',
      endedAt: '2026-07-30T20:00:00.000Z',
    });
    expect(reply.status).toBe(422);
  });

  it('404s an unknown challenge', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    const reply = await client.send('POST', '/api/challenges/ch_missing/end', {
      expectedRevision: revision,
      endReason: 'abandoned',
      endedAt: '2026-07-30T20:00:00.000Z',
    });
    expect(reply.status).toBe(404);
  });
});

describe('POST /api/challenges/next-block', () => {
  function successor(): Record<string, unknown> {
    return {
      ...challengeRecord(),
      id: 'ch_2',
      previousChallengeId: 'ch_1',
      startedAt: '2026-07-30T20:00:00.000Z',
      baseline: { value: 25, source: 'tested', evidenceId: 'test_9', recordedAt: '2026-07-30T19:55:00.000Z' },
    };
  }
  function test9(): Record<string, unknown> {
    return {
      id: 'test_9',
      exerciseId: 'ex_1',
      performedAt: '2026-07-30T19:55:00.000Z',
      protocolId: 'single-set-max-v1',
      protocolVersion: 1,
      value: 25,
      unit: 'reps',
    };
  }

  it('ends the block, records the test, creates the successor and moves the selection at once', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    const reply = await client.send('POST', '/api/challenges/next-block', {
      expectedRevision: revision,
      previousChallengeId: 'ch_1',
      endedAt: '2026-07-30T20:00:00.000Z',
      performanceTest: test9(),
      challenge: successor(),
      slots: [{ ...slotRecord(), id: 'slot_2', challengeId: 'ch_2' }],
    });
    expect(reply.status).toBe(201);
    const snapshot = snapshotOf(reply);
    expect(snapshot.challenges.find((c) => c.id === 'ch_1')).toMatchObject({
      status: 'ended',
      // Superseded by its successor, not closed by hand. See repo.ts:402.
      endReason: 'superseded',
    });
    expect(snapshot.challenges.find((c) => c.id === 'ch_2')?.status).toBe('active');
    expect(snapshot.performanceTests).toHaveLength(1);
    expect(snapshot.settings.selectedChallengeId).toBe('ch_2');
    expect(snapshot.revision).toBe(revision + 1);
  });

  it('leaves the previous block untouched when the successor is rejected', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    const reply = await client.send('POST', '/api/challenges/next-block', {
      expectedRevision: revision,
      previousChallengeId: 'ch_1',
      endedAt: '2026-07-30T20:00:00.000Z',
      challenge: { ...successor(), chainId: 'a_different_chain' },
      slots: [],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('chain_mismatch');
    // The failure this whole transaction exists to prevent: an ended plan with no successor.
    const snapshot = snapshotOf(reply);
    expect(snapshot.challenges).toHaveLength(1);
    expect(snapshot.challenges[0]?.status).toBe('active');
  });

  it('refuses a successor that trains a different exercise', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    const reply = await client.send('POST', '/api/challenges/next-block', {
      expectedRevision: revision,
      previousChallengeId: 'ch_1',
      endedAt: '2026-07-30T20:00:00.000Z',
      challenge: { ...successor(), exerciseId: 'ex_other' },
      slots: [],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('exercise_mismatch');
    expect(snapshotOf(reply).challenges[0]?.status).toBe('active');
  });

  it('refuses a successor that is itself, or one that starts ended', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    expect(
      (
        await client.send('POST', '/api/challenges/next-block', {
          expectedRevision: revision,
          previousChallengeId: 'ch_1',
          endedAt: '2026-07-30T20:00:00.000Z',
          challenge: { ...successor(), id: 'ch_1' },
          slots: [],
        })
      ).body['error'],
    ).toBe('successor_mismatch');
    expect(
      (
        await client.send('POST', '/api/challenges/next-block', {
          expectedRevision: revision,
          previousChallengeId: 'ch_1',
          endedAt: '2026-07-30T20:00:00.000Z',
          challenge: { ...successor(), status: 'ended', endedAt: '2026-07-31T20:00:00.000Z', endReason: 'abandoned' },
          slots: [],
        })
      ).body['error'],
    ).toBe('challenge_not_active');
  });

  it('refuses a retest for a different exercise', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    const reply = await client.send('POST', '/api/challenges/next-block', {
      expectedRevision: revision,
      previousChallengeId: 'ch_1',
      endedAt: '2026-07-30T20:00:00.000Z',
      performanceTest: { ...test9(), exerciseId: 'ex_other' },
      challenge: successor(),
      slots: [],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('test_exercise_mismatch');
    expect(snapshotOf(reply).challenges[0]?.status).toBe('active');
  });

  it('requires the successor to name the block it replaces', async () => {
    const harness = await start();
    const { client, revision } = await seeded(harness);
    const challenge = successor();
    delete challenge['previousChallengeId'];
    const reply = await client.send('POST', '/api/challenges/next-block', {
      expectedRevision: revision,
      previousChallengeId: 'ch_1',
      endedAt: '2026-07-30T20:00:00.000Z',
      challenge,
      slots: [],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('successor_mismatch');
  });
});

describe('POST /api/challenges/:id/extend', () => {
  /**
   * The seeded challenge with the extension recorded — and ONLY the extension. The stored
   * challenge's `patternParams` is `{}`, so anything else here is a change the server refuses.
   */
  function extended(extraSessions = 2): Record<string, unknown> {
    return { ...challengeRecord(), patternParams: { extraSessions, extensionDamping: 0.5 } };
  }
  function appended(ordinal: number): Record<string, unknown> {
    return { ...slotRecord(), id: `slot_${String(ordinal)}`, ordinal };
  }

  /** Seed, then perform the only session there is: a plan that has genuinely run out. */
  async function finished(harness: Harness): Promise<{ client: Client; revision: number }> {
    const { client } = await seeded(harness);
    const logged = await client.send('POST', '/api/workouts', { workout: workoutCommand() });
    expect(logged.status).toBe(201);
    const snapshot = snapshotOf(logged);
    expect(snapshot.planSlots[0]?.status).toBe('completed');
    return { client, revision: snapshot.revision };
  }

  it('appends slots, records the extension and bumps the revision once', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    const reply = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: revision,
      challenge: extended(),
      slots: [appended(2), appended(3)],
    });
    expect(reply.status).toBe(201);
    expect(reply.body['appended']).toBe(2);

    const snapshot = snapshotOf(reply);
    expect(snapshot.revision).toBe(revision + 1);
    expect(snapshot.planSlots.map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(snapshot.challenges[0]?.patternParams['extraSessions']).toBe(2);
    // Still the same challenge, still active: nothing ended, nothing was superseded.
    expect(snapshot.challenges).toHaveLength(1);
    expect(snapshot.challenges[0]?.status).toBe('active');
  });

  it('never alters a slot that already exists, whatever state it is in', async () => {
    const harness = await start();
    const { client } = await seeded(harness);

    // Perform the only session there is, so slot_1 is `completed` and a workout references it.
    const logged = await client.send('POST', '/api/workouts', { workout: workoutCommand() });
    expect(logged.status).toBe(201);
    const before = snapshotOf(logged);
    expect(before.planSlots[0]?.status).toBe('completed');

    const reply = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: before.revision,
      challenge: extended(),
      slots: [appended(2), appended(3)],
    });
    expect(reply.status).toBe(201);

    const after = snapshotOf(reply);
    expect(after.planSlots.find((s) => s.id === 'slot_1')).toEqual(before.planSlots[0]);
    expect(after.workouts).toEqual(before.workouts);
  });

  it('extends twice, continuing from the end each time', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    const first = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: revision,
      challenge: extended(2),
      slots: [appended(2), appended(3)],
    });
    expect(first.status).toBe(201);

    // The appended week has to be trained before another one can be added.
    let latest = snapshotOf(first);
    for (const ordinal of [2, 3]) {
      const logged = await client.send('POST', '/api/workouts', {
        workout: workoutCommand({ id: `wo_${String(ordinal)}`, planSlotId: `slot_${String(ordinal)}` }),
      });
      expect(logged.status).toBe(201);
      latest = snapshotOf(logged);
    }

    const second = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: latest.revision,
      challenge: extended(4),
      slots: [appended(4), appended(5)],
    });
    expect(second.status).toBe(201);
    const snapshot = snapshotOf(second);
    expect(snapshot.planSlots.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.challenges[0]?.patternParams['extraSessions']).toBe(4);
  });

  it('409s a stale command with the fresh snapshot, and appends nothing', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: revision,
      challenge: extended(2),
      slots: [appended(2), appended(3)],
    });

    const stale = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: revision,
      challenge: extended(4),
      slots: [appended(4), appended(5)],
    });
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toBe('revision_conflict');
    expect(snapshotOf(stale).planSlots).toHaveLength(3);
  });

  it('refuses to append over a block another device already added', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    const first = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: revision,
      challenge: extended(2),
      slots: [appended(2), appended(3)],
    });

    // Fresh revision, but the ordinals were composed against the plan as it was before.
    const overlapping = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: snapshotOf(first).revision,
      challenge: extended(4),
      slots: [
        { ...slotRecord(), id: 'slot_other_2', ordinal: 2 },
        { ...slotRecord(), id: 'slot_other_3', ordinal: 3 },
      ],
    });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body['error']).toBe('plan_not_contiguous');
    expect(snapshotOf(overlapping).planSlots).toHaveLength(3);
  });

  it('refuses a gap between the plan and the block being appended', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    const reply = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: revision,
      challenge: extended(),
      slots: [appended(3), appended(4)],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('plan_not_contiguous');
    expect(snapshotOf(reply).planSlots).toHaveLength(1);
  });

  it('refuses to change anything but the pattern params', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    for (const doctored of [
      { baseline: { value: 99, source: 'user_entered', recordedAt: '2026-07-30T20:00:00.000Z' } },
      { goalValue: 400 },
      { chainId: 'a_different_chain' },
      { startedAt: '2020-01-01T00:00:00.000Z' },
    ]) {
      const reply = await client.send('POST', '/api/challenges/ch_1/extend', {
        expectedRevision: revision,
        challenge: { ...extended(1), ...doctored },
        slots: [appended(2)],
      });
      expect(reply.status).toBe(409);
      expect(reply.body['error']).toBe('challenge_changed');
      expect(snapshotOf(reply).planSlots).toHaveLength(1);
    }
  });

  it('refuses to change how the plan is generated', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    // Codex round, 2026-07-31: the first draft blanked patternParams on both sides of the
    // comparison, which made this endpoint a way to rewrite the ramp of a challenge that already
    // had history — every one of these would have been accepted.
    for (const params of [
      { extraSessions: 1, extensionDamping: 0.5, baselineMax: 40 },
      { extraSessions: 1, extensionDamping: 0.5, goalMax: 400 },
      { extraSessions: 1, extensionDamping: 0.5, weeks: 7 },
      { extraSessions: 1, extensionDamping: 0.5, daysPerWeek: 5 },
      { extraSessions: 1, extensionDamping: 0.5, coefficients: [1, 1, 1] },
    ]) {
      const reply = await client.send('POST', '/api/challenges/ch_1/extend', {
        expectedRevision: revision,
        challenge: { ...challengeRecord(), patternParams: params },
        slots: [appended(2)],
      });
      expect(reply.status).toBe(409);
      expect(reply.body['error']).toBe('pattern_params_changed');
      expect(snapshotOf(reply).planSlots).toHaveLength(1);
    }
  });

  it('refuses an extension that does not record the sessions it appends', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    for (const extraSessions of [0, 1, 3, 99]) {
      const reply = await client.send('POST', '/api/challenges/ch_1/extend', {
        expectedRevision: revision,
        challenge: extended(extraSessions),
        slots: [appended(2), appended(3)],
      });
      expect(reply.status).toBe(409);
      expect(reply.body['error']).toBe('extension_not_recorded');
      expect(snapshotOf(reply).planSlots).toHaveLength(1);
    }
  });

  it('freezes the rate an extended plan climbs at, once it is written down', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    const first = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: revision,
      challenge: extended(1),
      slots: [appended(2)],
    });
    expect(first.status).toBe(201);
    const logged = await client.send('POST', '/api/workouts', {
      workout: workoutCommand({ id: 'wo_2', planSlotId: 'slot_2' }),
    });

    const reply = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: snapshotOf(logged).revision,
      challenge: { ...challengeRecord(), patternParams: { extraSessions: 2, extensionDamping: 1 } },
      slots: [appended(3)],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('pattern_params_changed');
    expect(snapshotOf(reply).planSlots).toHaveLength(2);
  });

  it('refuses to extend a plan that still has a session in it', async () => {
    const harness = await start();
    // Seeded but NOT performed: slot_1 is still `available`.
    const { client, revision } = await seeded(harness);
    const reply = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: revision,
      challenge: extended(),
      slots: [appended(2), appended(3)],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('plan_not_finished');
    expect(snapshotOf(reply).planSlots).toHaveLength(1);
  });

  it('refuses an ended challenge', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    const ended = await client.send('POST', '/api/challenges/ch_1/end', {
      expectedRevision: revision,
      endReason: 'closed_manually',
      endedAt: '2026-07-30T20:00:00.000Z',
    });
    expect(ended.status).toBe(200);

    const reply = await client.send('POST', '/api/challenges/ch_1/extend', {
      expectedRevision: snapshotOf(ended).revision,
      challenge: extended(),
      slots: [appended(2)],
    });
    expect(reply.status).toBe(409);
    expect(reply.body['error']).toBe('already_ended');
    expect(snapshotOf(reply).planSlots).toHaveLength(1);
  });

  it('refuses a body that names a different challenge, or that starts ended', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    expect(
      (
        await client.send('POST', '/api/challenges/ch_1/extend', {
          expectedRevision: revision,
          challenge: { ...extended(), id: 'ch_2' },
          slots: [{ ...appended(2), challengeId: 'ch_2' }],
        })
      ).body['error'],
    ).toBe('challenge_mismatch');
    expect(
      (
        await client.send('POST', '/api/challenges/ch_1/extend', {
          expectedRevision: revision,
          challenge: {
            ...extended(),
            status: 'ended',
            endedAt: '2026-07-30T20:00:00.000Z',
            endReason: 'abandoned',
          },
          slots: [appended(2)],
        })
      ).body['error'],
    ).toBe('challenge_not_active');
  });

  it('refuses an empty extension, and slots that arrive with history', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    expect(
      (
        await client.send('POST', '/api/challenges/ch_1/extend', {
          expectedRevision: revision,
          challenge: extended(0),
          slots: [],
        })
      ).body['error'],
    ).toBe('nothing_to_append');
    expect(
      (
        await client.send('POST', '/api/challenges/ch_1/extend', {
          expectedRevision: revision,
          challenge: extended(),
          slots: [{ ...appended(2), status: 'completed' }],
        })
      ).body['error'],
    ).toBe('slot_not_fresh');
  });

  it('404s an unknown challenge and rejects the wrong method', async () => {
    const harness = await start();
    const { client, revision } = await finished(harness);
    const missing = await client.send('POST', '/api/challenges/ch_missing/extend', {
      expectedRevision: revision,
      challenge: { ...extended(), id: 'ch_missing' },
      slots: [{ ...appended(2), challengeId: 'ch_missing' }],
    });
    expect(missing.status).toBe(404);
    expect((await client.send('GET', '/api/challenges/ch_1/extend')).status).toBe(405);
  });
});

// ── Import ──────────────────────────────────────────────────────────────────────────────────

describe('POST /api/import', () => {
  function unlinkedWorkout(id: string): Record<string, unknown> {
    return { ...(clone(MINIMAL_BACKUP.workouts[0]) as unknown as Record<string, unknown>), id };
  }

  it('writes a whole import in one transaction, unlinked workouts included', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('POST', '/api/import', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [slotRecord()],
      workouts: [unlinkedWorkout('imp_1'), unlinkedWorkout('imp_2')],
      select: true,
    });
    expect(reply.status).toBe(201);
    expect(reply.body['workoutCount']).toBe(2);
    const snapshot = snapshotOf(reply);
    expect(snapshot.workouts).toHaveLength(2);
    // Unlinked history keeps its own attempt numbers; the partial unique index allows it.
    expect(snapshot.workouts.every((w) => w.attemptNo === 1)).toBe(true);
    expect(snapshot.workouts.every((w) => !Object.hasOwn(w, 'planSlotId'))).toBe(true);
  });

  it('writes nothing when one workout is invalid', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const bad = { ...unlinkedWorkout('imp_bad'), actualTotal: -1 };
    const reply = await client.send('POST', '/api/import', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [slotRecord()],
      workouts: [unlinkedWorkout('imp_1'), bad],
    });
    expect(reply.status).toBe(422);
    const snapshot = await client.snapshot();
    expect(snapshot.workouts).toHaveLength(0);
    expect(snapshot.exercises).toHaveLength(0);
    expect(snapshot.revision).toBe(0);
  });

  it('refuses a workout that names a slot or challenge the import does not carry', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const linked = { ...unlinkedWorkout('imp_1'), planSlotId: 'slot_missing' };
    const reply = await client.send('POST', '/api/import', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [slotRecord()],
      workouts: [linked],
    });
    expect(reply.status).toBe(422);
    expect(reply.body['error']).toBe('unknown_plan_slot');
    expect((await client.snapshot()).revision).toBe(0);

    const foreign = { ...unlinkedWorkout('imp_2'), challengeId: 'ch_elsewhere' };
    const other = await client.send('POST', '/api/import', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [slotRecord()],
      workouts: [foreign],
    });
    expect(other.body['error']).toBe('workout_challenge_mismatch');
  });

  it('refuses two workouts claiming the same attempt on one slot', async () => {
    // The partial unique index would catch this, but as a raw SQLite error naming no record.
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const linked = (id: string): Record<string, unknown> => ({
      ...unlinkedWorkout(id),
      planSlotId: 'slot_1',
      attemptNo: 1,
    });
    const reply = await client.send('POST', '/api/import', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [slotRecord()],
      workouts: [linked('imp_1'), linked('imp_2')],
    });
    expect(reply.status).toBe(422);
    expect(reply.body['error']).toBe('attempt_collision');
    expect((await client.snapshot()).workouts).toHaveLength(0);
  });

  it('refuses a challenge that trains an exercise the import does not carry', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('POST', '/api/import', {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: { ...challengeRecord(), exerciseId: 'ex_other' },
      slots: [],
      workouts: [],
    });
    expect(reply.status).toBe(422);
    expect(reply.body['error']).toBe('exercise_mismatch');
  });

  it('is repeatable: identical content is a no-op, different content aborts', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const body = {
      expectedRevision: 0,
      exercise: exerciseRecord(),
      challenge: challengeRecord(),
      slots: [slotRecord()],
      workouts: [unlinkedWorkout('imp_1')],
    };
    expect((await client.send('POST', '/api/import', body)).status).toBe(201);

    const repeated = await client.send('POST', '/api/import', { ...body, expectedRevision: 1 });
    expect(repeated.status).toBe(201);
    expect(snapshotOf(repeated).workouts).toHaveLength(1);

    const conflicting = await client.send('POST', '/api/import', {
      ...body,
      expectedRevision: 2,
      workouts: [{ ...unlinkedWorkout('imp_1'), actualTotal: 77 }],
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body['error']).toBe('record_conflict');
    expect(snapshotOf(conflicting).workouts[0]?.actualTotal).toBe(0);
  });
});

// ── Settings ────────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/settings', () => {
  it('merges the patch onto what is stored', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const first = await client.send('PATCH', '/api/settings', {
      expectedRevision: 0,
      patch: { bodyweightKg: 82.5 },
    });
    expect(snapshotOf(first).settings).toEqual({
      id: 'settings',
      kcalCoefficient: 0.003,
      bodyweightKg: 82.5,
    });
    const second = await client.send('PATCH', '/api/settings', {
      expectedRevision: 1,
      patch: { onboardedAt: '2026-07-30T10:00:00.000Z' },
    });
    expect(snapshotOf(second).settings.bodyweightKg).toBe(82.5);
  });

  it('treats null as "clear this", because JSON has no undefined', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    await client.send('PATCH', '/api/settings', {
      expectedRevision: 0,
      patch: { restOverrideSeconds: 45 },
    });
    const cleared = await client.send('PATCH', '/api/settings', {
      expectedRevision: 1,
      patch: { restOverrideSeconds: null },
    });
    expect(Object.hasOwn(snapshotOf(cleared).settings, 'restOverrideSeconds')).toBe(false);
  });

  it('rejects a key settings do not have, and refuses to move the row id', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    expect(
      (await client.send('PATCH', '/api/settings', { expectedRevision: 0, patch: { theme: 'dark' } }))
        .status,
    ).toBe(400);
    expect(
      (await client.send('PATCH', '/api/settings', { expectedRevision: 0, patch: { id: 'other' } }))
        .status,
    ).toBe(400);
  });

  it('rejects a value the column cannot hold, and changes nothing', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('PATCH', '/api/settings', {
      expectedRevision: 0,
      patch: { bodyweightKg: 0 },
    });
    expect(reply.status).toBe(422);
    expect((await client.snapshot()).revision).toBe(0);
  });

  it('rejects an unknown top-level field on the command itself', async () => {
    const harness = await start();
    const client = new Client(harness.base);
    await client.login();
    const reply = await client.send('PATCH', '/api/settings', {
      expectedRevision: 0,
      patch: {},
      force: true,
    });
    expect(reply.status).toBe(400);
    expect(reply.body['error']).toBe('unknown_field');
  });
});

// ── Startup guards ──────────────────────────────────────────────────────────────────────────

describe('the Node version gate', () => {
  it('rejects the releases where node:sqlite is absent or behind a flag', () => {
    // `>=22` would be wrong: the module arrived in 22.5.0 and lost the flag in 22.13.0.
    expect(nodeVersionIsSupported('20.11.0')).toBe(false);
    expect(nodeVersionIsSupported('22.5.0')).toBe(false);
    expect(nodeVersionIsSupported('22.12.9')).toBe(false);
    expect(nodeVersionIsSupported('22.13.0')).toBe(true);
    expect(nodeVersionIsSupported('24.0.0')).toBe(true);
    expect(nodeVersionIsSupported('25.2.1')).toBe(true);
    expect(nodeVersionIsSupported('v25.2.1-nightly')).toBe(true);
  });

  it('refuses a major line nobody has run the suite on', () => {
    // The runtime gate and the `engines` range in package.json must say the same thing.
    expect(() => assertNodeVersion('26.0.0')).toThrow(/has not been tested/);
    expect(() => assertNodeVersion('30.1.2')).toThrow(/has not been tested/);
    expect(nodeMajor('v25.2.1')).toBe(25);
  });

  it('explains itself rather than failing later with an unknown module', () => {
    expect(() => assertNodeVersion('20.0.0')).toThrow(/node:sqlite/);
    expect(() => assertNodeVersion(process.versions.node)).not.toThrow();
  });
});

describe('listener configuration', () => {
  it('defaults to loopback and a pinned port', () => {
    expect(resolveBindHost(undefined)).toBe('127.0.0.1');
    expect(resolveBindHost('  ')).toBe('127.0.0.1');
    expect(resolveBindHost('0.0.0.0')).toBe('0.0.0.0');
    expect(resolvePort(undefined)).toBe(8787);
    expect(resolvePort('9000')).toBe(9000);
    expect(() => resolvePort('not-a-port')).toThrow();
    expect(() => resolvePort('70000')).toThrow();
  });
});
