/**
 * The process: one listener serving the built app and its API from one origin.
 *
 * One origin is not a convenience, it is three guarantees at once. No CORS, so no preflight and
 * no `Access-Control-Allow-*` header to get subtly wrong. `SameSite=Strict` on the session
 * cookie remains correct, which is the entire reason there is no CSRF token — see the note in
 * `server/session.ts`. And `connect-src 'self'` in the CSP is enough, because the app never
 * legitimately talks to anywhere else.
 *
 * Two entry points:
 *   node server/index.js          start the server; refuses without GODMODE_TOKEN
 *   node server/index.js token    print the generated secret, creating it on first use
 *
 * The second exists so the owner is never trained to paste a dummy value: `npm run serve` reads
 * a real secret from a 0600 file outside the repository and puts it in the child's environment.
 */

import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AttemptLimiter, digest, ensureTokenFile, requireToken, resolveTokenFile } from './auth.js';
import { currentHost, openDatabase, type Host, type OpenedDatabase } from './db.js';
import {
  HttpError,
  applySecurityHeaders,
  resolveStaticPath,
  sendError,
  sendFile,
} from './http.js';
import { API_VERSION, handleApi, type ApiContext } from './routes.js';
import { SessionStore } from './session.js';
import { fileSessionPersistence, sessionFilePath } from './sessionFile.js';

/**
 * The floor, and why it is not `>=22`.
 *
 * `node:sqlite` landed in 22.5.0 behind `--experimental-sqlite` and stopped needing the flag in
 * 22.13.0. `engines: {node: ">=22"}` would therefore admit releases where this server either
 * cannot load its database module at all or needs a flag nobody passes — a startup failure with
 * a message about an unknown module rather than about the Node version. The module is still
 * Stability 1.1, so the tested line is recorded here as well as in `package.json`.
 */
export const MINIMUM_NODE = '22.13.0';

/**
 * The first major line this build has not been tested against.
 *
 * Refusing it rather than warning keeps the runtime gate and `engines` in `package.json` saying
 * the same thing — two version policies that disagree is how a machine ends up running a
 * combination nobody chose. `node:sqlite` is Stability 1.1: an untested major is exactly where
 * its API is allowed to move. Raising this is a deliberate act: run the suite on the new line,
 * then change both numbers in the same commit.
 */
export const FIRST_UNTESTED_NODE_MAJOR = 26;
export const TESTED_NODE = '25.2.1';

/** How long a shutdown waits for a request already in flight before cutting its connection. */
export const SHUTDOWN_GRACE_MS = 250;

export function nodeVersionIsSupported(version: string, minimum = MINIMUM_NODE): boolean {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10));
  const found = parse(version);
  const floor = parse(minimum);
  for (let index = 0; index < floor.length; index += 1) {
    const a = found[index] ?? 0;
    const b = floor[index] ?? 0;
    if (Number.isNaN(a)) return false;
    if (a !== b) return a > b;
  }
  return true;
}

export function nodeMajor(version: string): number {
  return Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
}

export function assertNodeVersion(version = process.versions.node): void {
  if (!nodeVersionIsSupported(version)) {
    throw new Error(
      `GodMode needs Node ${MINIMUM_NODE} or newer; this is ${version}.\n` +
        '\n' +
        'The database is `node:sqlite`, which arrived in 22.5.0 behind --experimental-sqlite\n' +
        `and stopped needing the flag in ${MINIMUM_NODE}. The tested line is ${TESTED_NODE}.\n` +
        'Nothing has been opened.',
    );
  }
  const major = nodeMajor(version);
  if (Number.isFinite(major) && major >= FIRST_UNTESTED_NODE_MAJOR) {
    throw new Error(
      `GodMode has not been tested on Node ${version}; the tested line is ${TESTED_NODE}.\n` +
        '\n' +
        '`node:sqlite` is still marked Stability 1.1, so a new major is exactly where its\n' +
        'behaviour is allowed to change — and this process holds the only copy of the training\n' +
        'history. Run the test suite on this line, then raise FIRST_UNTESTED_NODE_MAJOR in\n' +
        'server/index.ts and the `engines` range in package.json together.\n' +
        'Nothing has been opened.',
    );
  }
}

export interface ServerOptions {
  readonly host?: Host;
  /** Overrides the resolved data directory. The tests and a container both need this. */
  readonly dataDir?: string;
  /** Built client. Absent or missing is not fatal — the API still works. */
  readonly staticRoot?: string;
  readonly token?: string;
  readonly now?: () => number;
  readonly sessions?: SessionStore;
  readonly limiter?: AttemptLimiter;
}

export interface RunningServer {
  readonly server: Server;
  readonly context: ApiContext;
  readonly opened: OpenedDatabase;
  close: () => Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the built client is.
 *
 * Two candidates, because this module runs from two places: `server/` in the source tree, where
 * `dist/` is one level up, and `dist-server/server/` in the build, where it is two. Picking the
 * one that actually contains an `index.html` is more honest than encoding a guess about which
 * of the two we are, and `GODMODE_STATIC_DIR` overrides both for a container that puts the
 * client somewhere else entirely.
 */
export function defaultStaticRoot(host: Host = currentHost()): string {
  const override = host.env['GODMODE_STATIC_DIR']?.trim();
  if (override !== undefined && override !== '') return resolve(override);
  const candidates = [resolve(HERE, '..', 'dist'), resolve(HERE, '..', '..', 'dist')];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html'))) ?? candidates[0]!;
}

/**
 * Build the listener without starting it, so tests can bind port 0 and drive the real thing.
 *
 * Everything injectable is injectable for that reason: the tests here open a real SQLite file
 * in a temporary directory and make real HTTP requests. A mocked database agrees with the
 * encoder by construction and would have proved nothing about either.
 */
export function createGodmodeServer(options: ServerOptions = {}): RunningServer {
  const host = options.host ?? currentHost();
  const token = options.token ?? requireToken(host);
  const opened = openDatabase({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    host,
  });

  const context: ApiContext = {
    db: opened.db,
    // Sessions outlive the process, in their own file beside the database — restarting the
    // server, or rebooting the machine, no longer signs every device out. It lives next to the
    // data rather than in it: see the note at the top of `server/sessionFile.ts`. A caller that
    // injects its own store (the tests) gets exactly what it passed and touches no file.
    sessions:
      options.sessions ??
      new SessionStore({ persistence: fileSessionPersistence(sessionFilePath(opened.dataDir)) }),
    tokenDigest: digest(token),
    limiter: options.limiter ?? new AttemptLimiter(),
    now: options.now ?? (() => Date.now()),
  };

  const staticRoot = options.staticRoot ?? defaultStaticRoot(host);

  const server = createServer((req, res) => {
    void handle(context, staticRoot, req, res).catch((cause: unknown) => {
      console.error('[godmode] request failed after the response began:', cause);
      if (!res.headersSent) {
        sendError(res, new HttpError(500, 'internal_error', 'That request failed.'));
      } else {
        res.destroy();
      }
    });
  });

  return {
    server,
    context,
    opened,
    close: async () => {
      await new Promise<void>((done) => {
        server.close(() => {
          clearTimeout(grace);
          done();
        });
        // `close` stops accepting and then waits for every open socket. Keep-alive sockets sit
        // there until their five-second timeout, which turns Ctrl-C into a long pause and makes
        // the tests slow for no reason. Idle ones go immediately; anything still mid-request
        // gets a short grace period and is then cut, because on a local single-user server the
        // longest request is a SQLite transaction measured in milliseconds.
        server.closeIdleConnections();
        const grace = setTimeout(() => {
          server.closeAllConnections();
        }, SHUTDOWN_GRACE_MS);
        grace.unref();
      });
      // Closes the connection *and* releases the ownership lock. A server that stopped listening
      // but kept the lock would block the importer for no reason; one that dropped the lock while
      // still holding the file open would be the bug the lock exists to prevent.
      opened.close();
    },
  };
}

async function handle(
  context: ApiContext,
  staticRoot: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  applySecurityHeaders(res);

  // A relative-URL base that is never used for anything but parsing the path.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    await handleApi(context, req, res, pathname);
    return;
  }

  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    sendError(
      res,
      new HttpError(405, 'method_not_allowed', `${method} is not allowed on ${pathname}.`),
    );
    return;
  }

  const requested = pathname === '/' ? '/index.html' : pathname;
  const absolute = resolveStaticPath(staticRoot, requested);
  if (absolute !== undefined) {
    const relative = requested.replace(/^\/+/, '');
    if (await sendFile(res, absolute, relative, method)) return;
  }

  // Single-page app: any path that is not a file is a route the client owns. `/api` never
  // reaches here, so an API typo can never be answered with the shell.
  const shell = resolveStaticPath(staticRoot, '/index.html');
  if (shell !== undefined && (await sendFile(res, shell, 'index.html', method))) return;

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    'The built app is not here yet. Run `npm run build`, then reload.\n' +
      `The API is running at /api (version ${String(API_VERSION)}).\n`,
  );
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────────

export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`GODMODE_SERVER_PORT must be an integer from 0 to 65535, received "${raw}".`);
  }
  return port;
}

/**
 * The bind address defaults to loopback.
 *
 * Reaching the app from a phone means setting `GODMODE_SERVER_HOST=0.0.0.0`, which is a
 * deliberate act — and one that needs TLS, because the session cookie is `Secure` and browsers
 * only exempt localhost from that rule.
 */
export function resolveBindHost(raw: string | undefined): string {
  const value = raw?.trim();
  return value === undefined || value === '' ? '127.0.0.1' : value;
}

async function main(argv: readonly string[]): Promise<void> {
  assertNodeVersion();
  const host = currentHost();

  if (argv[0] === 'token') {
    // Printed on purpose: the owner has to type it into the app once per device. It goes to
    // stdout so `npm run serve` can capture it into the child's environment without it ever
    // reaching a log file or a URL.
    process.stdout.write(`${ensureTokenFile(resolveTokenFile(host))}\n`);
    return;
  }
  if (argv.length > 0) {
    throw new Error(`Unknown argument "${String(argv[0])}". Usage: server [token]`);
  }

  const running = createGodmodeServer({ host });
  const port = resolvePort(host.env['GODMODE_SERVER_PORT']);
  const bind = resolveBindHost(host.env['GODMODE_SERVER_HOST']);

  await new Promise<void>((done) => {
    running.server.listen(port, bind, done);
  });

  const address = running.server.address();
  const shown = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`[godmode] data      ${running.opened.path}`);
  console.log(`[godmode] listening http://${bind}:${String(shown)}`);
  if (bind !== '127.0.0.1' && bind !== 'localhost') {
    console.warn(
      '[godmode] bound beyond loopback. The session cookie is Secure, which browsers only\n' +
        '[godmode] exempt for localhost, so sign-in will fail until this is behind TLS.',
    );
  }

  const stop = (): void => {
    void running.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // A last, synchronous chance to hand the database back — an uncaught throw, or `process.exit`
  // from somewhere that never ran `stop`. SIGKILL and a power cut still leave the lock file
  // behind; that is the stale case, and `server/lock.ts` detects and recovers from exactly that.
  //
  // `opened.close()`, never a bare `lock.release()`: releasing the lock while this process still
  // has the database open would advertise the file as free for the remainder of exit-handler time,
  // which is the precise state the lock exists to make impossible. `close` is idempotent, so this
  // costs nothing when `stop` already ran.
  process.on('exit', () => {
    running.opened.close();
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(join(HERE, 'index.js'));

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exit(1);
  });
}
