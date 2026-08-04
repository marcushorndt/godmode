# Running the server

Written 2026-07-30, alongside step 3 of `.planning/DESIGN-server-sqlite.md`. The client still
talks to IndexedDB at this point — the cutover is step 5 — so what follows is how to run and
deploy the server itself, and the constraints a deployment inherits from decisions already made.

## Locally

```
npm run start        # build the client, build the server, generate a secret, listen
npm run token        # print that secret, so you can type it into the app
```

`npm run start` is `npm run build` followed by `npm run serve`. `serve` reads — or on first use
generates — a 256-bit secret and puts it in the server's environment. You are never asked to
invent a token, and there is no default one to fall into the habit of pasting.

Defaults: `http://127.0.0.1:8787`, loopback only.

| Variable | Default | What it does |
|---|---|---|
| `GODMODE_TOKEN` | *(none — the server refuses to start)* | The shared secret. |
| `GODMODE_TOKEN_FILE` | `~/Library/Application Support/godmode/token` (macOS) · `$XDG_CONFIG_HOME/godmode/token` else `~/.config/godmode/token` | Where `npm run token` keeps it, mode 0600. |
| `GODMODE_DATA_DIR` | `~/Library/Application Support/godmode/` (macOS) · `$XDG_DATA_HOME/godmode/` else `~/.local/share/godmode/` | Where `godmode.sqlite` lives. |
| `GODMODE_STATIC_DIR` | the `dist/` beside the build | The built client. |
| `GODMODE_SERVER_PORT` | `8787` | |
| `GODMODE_SERVER_HOST` | `127.0.0.1` | Set to `0.0.0.0` to be reachable — see TLS below. |

## As a macOS app

```
scripts/install-macos-app.sh              # install, or reinstall over an existing one
scripts/install-macos-app.sh --dry-run    # build the bundle somewhere harmless, load nothing
scripts/install-macos-app.sh --uninstall  # remove the app, the agent and the log
```

Two artefacts, and nothing else: `/Applications/GodMode.app`, and a LaunchAgent
(`de.horndt.godmode`) that keeps the server running whenever you are logged in — which is also
what lets a phone reach it without someone opening a laptop first. There is no Electron here on
purpose: the server already serves the built client, so the app is one process on one URL and
the browser you have is better than a bundled one.

The bundle records the path to the checkout and runs the build inside it, rather than copying a
build into itself, so `npm run build && npm run build:server` updates the installed app with no
reinstall step. Moving the repository breaks it, and the launcher says so in a dialog rather than
failing silently.

The agent runs `Contents/MacOS/godmode-server`, not `node` directly. That wrapper does what
`npm run serve` does — asks the server to print the secret it keeps at 0600 and hands it to the
real process through the environment. **Do not "simplify" this by putting `GODMODE_TOKEN` in the
plist's `EnvironmentVariables`**: it would copy the secret into a second file in a directory that
is not 0600, for nothing. The installer greps its own output for the token and refuses to
install if it finds it.

Restarting after a rebuild:

```
launchctl kickstart -k gui/$(id -u)/de.horndt.godmode
```

None of this is on the VPS path. A server deployment is the section below; the two share the
binary and nothing else.

## The four things a deployment must get right

### 1. TLS is not optional the moment this leaves localhost

The session cookie is `HttpOnly; Secure; SameSite=Strict`. `Secure` means browsers refuse the
cookie over plain HTTP — with one exception, loopback, which browsers treat as a potentially
trustworthy origin.

**Open the app at `http://localhost:8787`.** That spelling is the one every current engine
documents; engines have not always agreed about other loopback spellings. **Sign-in will not
work over plain HTTP at any other address**, and that is deliberate: a deployment without TLS
should fail loudly at the login screen rather than quietly send the secret in clear text. Put it
behind a reverse proxy that terminates TLS on the same public origin, forwards to the loopback
port, and passes `Set-Cookie` through unchanged.

The server prints a warning when it binds beyond loopback, for the same reason.

### 2. The app and the API must stay on one origin

`server/index.ts` serves the built client and `/api` from one listener. That is what makes
`SameSite=Strict` a complete CSRF defence and lets the CSP say `connect-src 'self'`. **Splitting
them across origins requires a CSRF token in the same change**, because the obvious fix for
"the app can no longer reach its API" is `SameSite=None`, and that edit silently reopens CSRF.
The reasoning is written next to the cookie in `server/session.ts`; do not let it drift.

### 3. Node version

`engines` says `>=22.13.0 <26`, and `server/index.ts` fails startup with an explicit message
below that floor. `>=22` would be wrong: `node:sqlite` arrived in 22.5.0 behind
`--experimental-sqlite` and stopped needing the flag only in 22.13.0. The upper bound is there
because the module is still Stability 1.1 — an unreleased major is not something to opt into by
default. Tested line: **25.2.1**.

### 4. The data directory is not in the repository, and that is the point

`git clean -xdf` deletes ignored files and is a routine command. A gitignored database inside a
checkout is one ordinary command away from being destroyed. So the default is the platform's
per-user application-state directory, the server creates it on first run, and it refuses to
start if it is not writable rather than silently falling back somewhere surprising.

`GODMODE_DATA_DIR=./.data` is a legitimate *development* choice. The token file deliberately
does not follow it — a secret must never land in a directory that gets shared or archived.

**Back it up.** The file is `godmode.sqlite` plus its `-wal` and `-shm` siblings; copy all three,
or use `sqlite3 godmode.sqlite ".backup out.sqlite"` for a consistent single file.

## One process owns the database at a time

The server takes `godmode.sqlite.lock` before it opens the database and gives it back when it
closes. The migration importer takes the same lock before it reads anything and holds it through
the rename that replaces the file. So:

- **Starting a second server** against the same data directory fails with a message naming the
  process that already has it — instead of two servers writing to one file.
- **Running `npm run import-backup` while the server is up** fails the same way, instead of
  renaming a fresh database over the one the server has open and leaving every write that server
  makes afterwards in an unlinked inode nobody will ever read. Stop the server, then import.

**After a crash or a power cut** the lock file outlives its holder. The server detects that by
itself — a recorded process id that is no longer running on this host — reclaims the lock, and says
so on startup, keeping the old lock file as `godmode.sqlite.lock.stale-<uuid>`. So an unattended
restart works.

The importer deliberately does *not* reclaim by itself: it is the side that replaces the file.
It refuses, prints who held the lock and why it judges it stale, and you re-run with
`--break-stale-lock`. That flag is not a `--force` — it refuses a lock whose holder is still
alive, and refuses one it cannot judge at all (another hostname, another process namespace, a
process id reused since a reboot, or a lock file that will not parse). For those, check by hand
that no server is running and delete `godmode.sqlite.lock` yourself.

**This protocol assumes every participant shares one filesystem and one process namespace.** Two
environments where that can fail, both described in full in `server/PERSISTENCE.md` §15:

- **NFS** — exclusive create is not reliably atomic on older NFSv3 paths. Keep the database on
  local storage.
- **Containers** — process ids are namespaced, so a lock written in one container cannot be judged
  from another and will never be broken automatically. A hard-killed container therefore leaves a
  lock its replacement refuses. Deleting it in the entrypoint is **only** safe if your orchestrator
  guarantees the old task is gone before the new one starts — rolling deployments and multi-replica
  services do not. If it cannot, get exclusivity from outside: one replica, or a volume that only
  one task can attach.

## What the API guarantees

- `GET /api/snapshot` returns the whole dataset in one read transaction, with a `revision` and
  an `apiVersion`.
- Every ordinary command carries `expectedRevision`; a mismatch is `409` **with the fresh
  snapshot attached**, never a silent overwrite.
- `POST /api/workouts` is the exception, on purpose: it is append-only and idempotent on a
  client-generated id, so a workout finished offline still lands however stale the device is.
  Posting the same id twice returns the original stored workout and changes nothing.
- `attempt_no` is an immutable server-acceptance sequence, not a chronology. Display order is
  `performed_at`. Existing attempts are never renumbered.
- Every command is retry-safe: an id already present with identical content is a no-op, and one
  present with different content aborts the whole command.

## Rotating the token

Delete the token file, run `npm run token` for a new one, and restart. Sessions live in memory,
so a restart ends every one of them.
