// @vitest-environment node
//
// Sessions that outlive the process.
//
// The property this file exists to establish cannot be shown by a unit test on the store alone:
// it is that a browser holding a cookie is still signed in after the *server* has been stopped
// and started again. So the last describe block runs two real servers in sequence over one data
// directory and re-presents the same cookie to the second one, which is exactly the thing the
// owner does when the app restarts.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGodmodeServer, type RunningServer } from './index.js';
import {
  SESSION_COOKIE,
  SessionStore,
  sessionKey,
  type SessionEntry,
  type SessionPersistence,
} from './session.js';
import { fileSessionPersistence, sessionFilePath, SESSION_FILE_VERSION } from './sessionFile.js';

const TOKEN = 'a-token-long-enough-to-be-accepted';
const T0 = Date.UTC(2026, 7, 4, 9, 0, 0);

const dirs: string[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const running = servers.pop();
    if (running !== undefined) await running.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'godmode-session-'));
  dirs.push(dir);
  return dir;
}

/** A persistence that keeps the last saved map, so a "restart" is just building a new store. */
function memoryPersistence(): SessionPersistence & { saves: number } {
  let saved = new Map<string, SessionEntry>();
  const api = {
    saves: 0,
    load: () => new Map(saved),
    save: (entries: Map<string, SessionEntry>) => {
      api.saves += 1;
      saved = new Map([...entries].map(([k, v]) => [k, { ...v }]));
    },
  };
  return api;
}

describe('a session survives the store being rebuilt', () => {
  it('comes back valid, with its original creation time', () => {
    const persistence = memoryPersistence();
    const first = new SessionStore({ persistence });
    const id = first.create(T0);
    expect(first.expiresAt(id)).toBeDefined();

    const second = new SessionStore({ persistence });
    expect(second.size).toBe(1);
    expect(second.validate(id, T0 + 60_000)).toBe(true);
    // The absolute deadline is measured from the original sign-in, not from the restart. A
    // restart that reset it would make a 30-day session immortal for anyone who restarts often.
    expect(second.expiresAt(id)).toBe(first.expiresAt(id));
  });

  it('does not resurrect a session that expired while the server was down', () => {
    const persistence = memoryPersistence();
    const first = new SessionStore({ persistence, maxAgeMs: 1000, idleMs: 1000 });
    const id = first.create(T0);

    const second = new SessionStore({ persistence, maxAgeMs: 1000, idleMs: 1000 });
    expect(second.validate(id, T0 + 5000)).toBe(false);
  });

  it('forgets a session that was signed out before the restart', () => {
    const persistence = memoryPersistence();
    const first = new SessionStore({ persistence });
    const id = first.create(T0);
    first.destroy(id);

    expect(new SessionStore({ persistence }).validate(id, T0 + 1000)).toBe(false);
  });

  it('forgets everything after the token is rotated', () => {
    const persistence = memoryPersistence();
    const first = new SessionStore({ persistence });
    const id = first.create(T0);
    first.destroyAll();

    expect(new SessionStore({ persistence }).validate(id, T0 + 1000)).toBe(false);
  });

  it('behaves exactly as before when nothing is persisting it', () => {
    const store = new SessionStore();
    const id = store.create(T0);
    expect(store.validate(id, T0 + 1000)).toBe(true);
    expect(new SessionStore().validate(id, T0 + 1000)).toBe(false);
  });
});

describe('writing sessions does not become a write per request', () => {
  it('throttles the idle-clock refresh but never a create or a destroy', () => {
    const persistence = memoryPersistence();
    const store = new SessionStore({ persistence, flushIntervalMs: 60_000 });

    const id = store.create(T0);
    const afterCreate = persistence.saves;
    expect(afterCreate).toBeGreaterThan(0);

    // A hundred requests in the same minute: the first refresh may write, the rest must not.
    for (let i = 1; i <= 100; i += 1) store.validate(id, T0 + i);
    expect(persistence.saves - afterCreate).toBeLessThanOrEqual(1);

    // Past the interval, one more write is allowed.
    store.validate(id, T0 + 120_000);
    const afterRefresh = persistence.saves;

    store.destroy(id);
    expect(persistence.saves).toBeGreaterThan(afterRefresh);
  });

  it('keeps working when saving throws', () => {
    const store = new SessionStore({
      persistence: {
        load: () => new Map(),
        save: () => {
          throw new Error('read-only filesystem');
        },
      },
    });
    // A session that cannot be written down is still a session. Failing the sign-in here would
    // turn a durability problem into an availability one.
    const id = store.create(T0);
    expect(store.validate(id, T0 + 1000)).toBe(true);
  });
});

describe('the session file itself', () => {
  it('holds digests, never anything that could be presented as a cookie', () => {
    const dir = tempDir();
    const path = sessionFilePath(dir);
    const store = new SessionStore({ persistence: fileSessionPersistence(path) });
    const id = store.create(T0);

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(id);
    expect(raw).toContain(sessionKey(id));
    expect(JSON.parse(raw)).toMatchObject({ version: SESSION_FILE_VERSION });
  });

  it('is readable only by its owner', () => {
    const dir = tempDir();
    const path = sessionFilePath(dir);
    new SessionStore({ persistence: fileSessionPersistence(path) }).create(T0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('is removed entirely once the last session is gone', () => {
    const dir = tempDir();
    const path = sessionFilePath(dir);
    const store = new SessionStore({ persistence: fileSessionPersistence(path) });
    const id = store.create(T0);
    expect(existsSync(path)).toBe(true);

    store.destroy(id);
    expect(existsSync(path)).toBe(false);
  });

  it('treats an unreadable file as no sessions rather than as a fatal error', () => {
    const dir = tempDir();
    const path = sessionFilePath(dir);
    writeFileSync(path, '{ this is not json');
    const warnings: string[] = [];

    const store = new SessionStore({
      persistence: fileSessionPersistence(path, (message) => warnings.push(message)),
    });
    expect(store.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('sign in again');

    // And it recovers: the next sign-in replaces the corrupt file.
    const id = store.create(T0);
    expect(new SessionStore({ persistence: fileSessionPersistence(path) }).validate(id, T0)).toBe(
      true,
    );
  });

  it('refuses a file written by a future version rather than guessing at it', () => {
    const dir = tempDir();
    const path = sessionFilePath(dir);
    writeFileSync(path, JSON.stringify({ version: SESSION_FILE_VERSION + 1, sessions: {} }));
    const warnings: string[] = [];

    const store = new SessionStore({
      persistence: fileSessionPersistence(path, (message) => warnings.push(message)),
    });
    expect(store.size).toBe(0);
    expect(warnings[0]).toContain('version');
  });

  it('drops only the malformed rows, keeping the sessions that decode', () => {
    const dir = tempDir();
    const path = sessionFilePath(dir);
    const good = new SessionStore({ persistence: fileSessionPersistence(path) });
    const id = good.create(T0);

    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      sessions: Record<string, unknown>;
    };
    parsed.sessions['not-a-digest'] = { createdAt: T0, lastSeenAt: T0 };
    parsed.sessions['b'.repeat(64)] = { createdAt: 'yesterday', lastSeenAt: T0 };
    writeFileSync(path, JSON.stringify(parsed));

    const store = new SessionStore({ persistence: fileSessionPersistence(path) });
    expect(store.size).toBe(1);
    expect(store.validate(id, T0 + 1000)).toBe(true);
  });
});

describe('restarting the server keeps the browser signed in', () => {
  async function startServer(dir: string): Promise<{ base: string; running: RunningServer }> {
    const staticRoot = join(dir, 'static');
    if (!existsSync(staticRoot)) mkdirSync(staticRoot);
    const running = createGodmodeServer({ dataDir: dir, staticRoot, token: TOKEN });
    servers.push(running);
    await new Promise<void>((done) => {
      running.server.listen(0, '127.0.0.1', done);
    });
    const address = running.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no address');
    return { base: `http://127.0.0.1:${String(address.port)}`, running };
  }

  it('accepts the same cookie against a server that was stopped and started again', async () => {
    const dir = tempDir();

    const first = await startServer(dir);
    const login = await fetch(`${first.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(login.status).toBe(200);
    const cookie = /godmode_session=([^;]*)/.exec(login.headers.getSetCookie()[0] ?? '')?.[1];
    expect(cookie).toBeTruthy();

    const before = await fetch(`${first.base}/api/snapshot`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie ?? ''}` },
    });
    expect(before.status).toBe(200);

    // The restart. The process that minted the session is gone, lock and all.
    await first.running.close();
    servers.splice(servers.indexOf(first.running), 1);

    const second = await startServer(dir);
    const after = await fetch(`${second.base}/api/snapshot`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie ?? ''}` },
    });
    expect(after.status).toBe(200);
  });

  it('still refuses a cookie that was never issued', async () => {
    const dir = tempDir();
    const first = await startServer(dir);
    await fetch(`${first.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    await first.running.close();
    servers.splice(servers.indexOf(first.running), 1);

    const second = await startServer(dir);
    const reply = await fetch(`${second.base}/api/snapshot`, {
      headers: { cookie: `${SESSION_COOKIE}=made-up-session-id` },
    });
    expect(reply.status).toBe(401);
  });
});
