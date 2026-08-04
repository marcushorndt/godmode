/**
 * Where sessions live between one run of the server and the next.
 *
 * ## Why not in `godmode.sqlite`
 *
 * A session is not training data, and putting it in the training database would have made it
 * behave like training data in three places that matter. It would need a row in the
 * `server/PERSISTENCE.md` matrix, which is a promise about the *dataset*. It would be swept into
 * `GET /api/export` and every backup file — so a backup someone mails to a friend, or drops in a
 * shared folder, would be carrying live credentials. And a restore would resurrect sessions that
 * were signed out months ago, on a machine that never held them.
 *
 * So sessions get their own small file next to the database, and the schema version, the
 * migration path and the 105-row persistence matrix stay untouched by this feature. The one
 * thing that guarantees a single writer is the database lock the server already holds
 * (`server/lock.ts`): one server owns the data directory, so one server owns this file.
 *
 * ## Why the file holds digests, not session ids
 *
 * A session id in this file would be a working cookie. Anyone who could read it — a stray
 * backup of the home directory, a synced folder, a second user on the machine — could paste it
 * in and be signed in. So the file holds a SHA-256 digest of each id and the store looks up by
 * digest, exactly as `server/auth.ts` does for the token. Reading this file tells you how many
 * sessions exist and when they were last used, and nothing that can be presented to the server.
 *
 * The file is written `0600` for the same reason the token file is, and replaced by
 * `writeFileSync` to a temporary name followed by `renameSync`, so a crash mid-write leaves the
 * previous file intact rather than a truncated one. A corrupt or unreadable file is treated as
 * "no sessions" rather than as a fatal error: the cost is one sign-in, and refusing to start the
 * server over an auth cache would be a worse failure than the one it reports.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionEntry, SessionPersistence } from './session.js';

/** The file's own format version, independent of the database's `schema_version`. */
export const SESSION_FILE_VERSION = 1;

export const SESSION_FILENAME = 'sessions.json';

interface StoredShape {
  readonly version: number;
  readonly sessions: Record<string, { createdAt: number; lastSeenAt: number }>;
}

/**
 * A session file at `path`.
 *
 * `onWarn` receives the one-line explanation when a file exists but cannot be used. It defaults
 * to `console.warn` because that failure is worth seeing in the server log: it means someone was
 * signed out for a reason other than expiry.
 */
export function fileSessionPersistence(
  path: string,
  onWarn: (message: string) => void = (message) => {
    console.warn(message);
  },
): SessionPersistence {
  return {
    load(): Map<string, SessionEntry> {
      const empty = new Map<string, SessionEntry>();
      if (!existsSync(path)) return empty;

      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (cause) {
        onWarn(
          `[godmode] ${path} could not be read (${describe(cause)}); starting with no sessions. ` +
            'You will need to sign in again.',
        );
        return empty;
      }

      if (!isStoredShape(parsed)) {
        onWarn(
          `[godmode] ${path} is not a session file this build understands; starting with no ` +
            'sessions. You will need to sign in again.',
        );
        return empty;
      }
      if (parsed.version !== SESSION_FILE_VERSION) {
        onWarn(
          `[godmode] ${path} is version ${String(parsed.version)}; this build writes version ` +
            `${String(SESSION_FILE_VERSION)}. Starting with no sessions.`,
        );
        return empty;
      }

      const out = new Map<string, SessionEntry>();
      for (const [key, value] of Object.entries(parsed.sessions)) {
        // A record that does not decode is dropped on its own rather than condemning the file.
        // The worst case is one device signing in again; discarding every other session because
        // one row is malformed would be a larger failure than the one being handled.
        if (!isDigestKey(key)) continue;
        if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.lastSeenAt)) continue;
        out.set(key, { createdAt: value.createdAt, lastSeenAt: value.lastSeenAt });
      }
      return out;
    },

    save(entries: Map<string, SessionEntry>): void {
      // Nothing to keep: remove the file rather than leaving `{}` behind, so signing out on the
      // only device leaves no trace of having been signed in.
      if (entries.size === 0) {
        if (existsSync(path)) unlinkSync(path);
        return;
      }

      const sessions: Record<string, { createdAt: number; lastSeenAt: number }> = {};
      for (const [key, entry] of entries) {
        sessions[key] = { createdAt: entry.createdAt, lastSeenAt: entry.lastSeenAt };
      }
      const body: StoredShape = { version: SESSION_FILE_VERSION, sessions };

      mkdirSync(dirname(path), { recursive: true });
      // Temp-then-rename: `renameSync` within a directory is atomic, so a crash at any point
      // leaves either the old file or the new one, never half of either.
      const temp = `${path}.tmp-${String(process.pid)}`;
      writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    },
  };
}

/** The session file inside a data directory. */
export function sessionFilePath(dataDir: string): string {
  return join(dataDir, SESSION_FILENAME);
}

function isStoredShape(value: unknown): value is StoredShape {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['version'] !== 'number') return false;
  const sessions = record['sessions'];
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return false;
  return Object.values(sessions as Record<string, unknown>).every(
    (entry) => typeof entry === 'object' && entry !== null,
  );
}

/** 32 bytes of SHA-256, hex. Anything else was not written by this store. */
function isDigestKey(key: string): boolean {
  return /^[0-9a-f]{64}$/.test(key);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
