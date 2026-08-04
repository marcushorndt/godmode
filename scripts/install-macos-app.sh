#!/bin/bash
#
# Install GodMode as a macOS app: an icon in /Applications and a server that is simply always
# running.
#
# ── What this is, and what it deliberately is not ───────────────────────────────────────────
#
# It is not Electron. The server already serves the built client — `server/index.ts` finds
# whichever `dist/` actually contains an `index.html`, and `server/http.ts` serves it with cache
# headers — so the app is one process on one URL and the browser you already have is a better
# browser than a bundled one. Electron would add ~150 MB and a second runtime to display a page
# Chrome displays now.
#
# So two pieces, and only two:
#
#   1. A LaunchAgent, so the server is running whenever you are logged in — which is also what
#      lets your phone reach it without anyone opening a laptop lid first.
#   2. A small .app bundle, so there is an icon that opens a window pointed at it.
#
# ── The app runs from this repository ───────────────────────────────────────────────────────
#
# The bundle records the path to this checkout and runs the build inside it, rather than copying
# a build into itself. That is the honest arrangement for a repo that is still being developed:
# `npm run build && npm run build:server` updates the installed app, with no reinstall step and
# no way for the icon in /Applications to quietly serve last month's code. The cost is that
# moving or deleting this directory breaks the app — so the launcher says exactly that when the
# path is gone, instead of failing silently.
#
# ── Usage ───────────────────────────────────────────────────────────────────────────────────
#
#   scripts/install-macos-app.sh              install (or reinstall over an existing one)
#   scripts/install-macos-app.sh --uninstall  remove the app, the LaunchAgent and the logs
#   scripts/install-macos-app.sh --dry-run    build the bundle somewhere harmless, touch no
#                                             LaunchAgent, start nothing
#
# Your data is never touched by any of them. It lives in ~/Library/Application Support/godmode.
#
# `GODMODE_APP_DIR` and `GODMODE_AGENT_PLIST` override where the two artefacts are written.
# They exist so this script can be exercised end to end without writing to /Applications or
# loading anything into launchd — an installer nobody can run without consequences is an
# installer nobody tests.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="GodMode"
BUNDLE_ID="de.horndt.godmode"
AGENT_LABEL="${BUNDLE_ID}"
APP_DIR="${GODMODE_APP_DIR:-/Applications/${APP_NAME}.app}"
AGENT_PLIST="${GODMODE_AGENT_PLIST:-${HOME}/Library/LaunchAgents/${AGENT_LABEL}.plist}"
DRY_RUN=0
LOG_DIR="${HOME}/Library/Logs"
LOG_FILE="${LOG_DIR}/godmode.log"
PORT="${GODMODE_SERVER_PORT:-8787}"
URL="http://localhost:${PORT}"

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# ── Uninstall ───────────────────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--uninstall" ]]; then
  say "Stopping the background server"
  launchctl bootout "gui/$(id -u)/${AGENT_LABEL}" 2>/dev/null || true
  rm -f "${AGENT_PLIST}"
  say "Removing ${APP_DIR}"
  rm -rf "${APP_DIR}"
  rm -f "${LOG_FILE}"
  echo
  echo "Removed. Your training data is untouched, in:"
  echo "  ~/Library/Application Support/godmode/"
  exit 0
fi

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  say "Dry run: nothing will be loaded into launchd and nothing will be started."
fi

[[ "$(uname -s)" == "Darwin" ]] || die "This installer is macOS only."

# ── The pieces this needs from the system ───────────────────────────────────────────────────

NODE_BIN="$(command -v node || true)"
[[ -n "${NODE_BIN}" ]] || die "node is not on PATH. Install Node 22.13+ and try again."
# A LaunchAgent starts with a minimal PATH and will not find a version-managed node, so the
# absolute path is baked in. Re-run this installer after switching Node versions.
NODE_BIN="$(cd "$(dirname "${NODE_BIN}")" && pwd)/$(basename "${NODE_BIN}")"
say "Using node at ${NODE_BIN} ($("${NODE_BIN}" --version))"

# ── Build ───────────────────────────────────────────────────────────────────────────────────

say "Building the client and the server"
cd "${REPO}"
npm run build >/dev/null
npm run build:server >/dev/null
[[ -f "${REPO}/dist/index.html" ]] || die "The client build produced no dist/index.html."
[[ -f "${REPO}/dist-server/server/index.js" ]] || die "The server build produced no dist-server."

# ── The .app bundle ─────────────────────────────────────────────────────────────────────────

say "Writing ${APP_DIR}"
rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"

VERSION="$(node -p "require('${REPO}/package.json').version" 2>/dev/null || echo 0.1.0)"

cat > "${APP_DIR}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
PLIST

# The icon, from the PWA's own 512px one. `iconutil` accepts a partial iconset, so the sizes
# that would need upscaling past the source are simply not generated — a blurry 1024 icon is
# worse than letting macOS scale the 512 itself.
if [[ -f "${REPO}/public/icon-512.png" ]] && command -v iconutil >/dev/null; then
  say "Generating the icon"
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "${ICONSET}"
  for size in 16 32 64 128 256 512; do
    sips -z "${size}" "${size}" "${REPO}/public/icon-512.png" \
      --out "${ICONSET}/icon_${size}x${size}.png" >/dev/null 2>&1 || true
  done
  for size in 16 32 128 256; do
    double=$((size * 2))
    sips -z "${double}" "${double}" "${REPO}/public/icon-512.png" \
      --out "${ICONSET}/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "${ICONSET}" -o "${APP_DIR}/Contents/Resources/AppIcon.icns" 2>/dev/null || \
    say "The icon could not be built; the app will use the generic one."
  rm -rf "$(dirname "${ICONSET}")"
fi

# The server wrapper the LaunchAgent runs.
#
# It exists because the server refuses to start without `GODMODE_TOKEN` in its environment
# (`server/auth.ts:requireToken`) — deliberately: there is no default and no unauthenticated
# mode. The obvious shortcut would be to write the token into the plist's EnvironmentVariables,
# which would put the secret in a second file, in a directory that is not 0600, for no benefit.
# Instead this does exactly what `npm run serve` does: ask the server to print the secret it
# already keeps at 0600, hand it to the real process through the environment, and never let it
# reach a log. Command substitution keeps it off stdout, which launchd is redirecting to a file.
cat > "${APP_DIR}/Contents/MacOS/godmode-server" <<SERVER
#!/bin/bash
set -euo pipefail
cd "${REPO}"
GODMODE_TOKEN="\$("${NODE_BIN}" dist-server/server/index.js token)"
export GODMODE_TOKEN
exec "${NODE_BIN}" dist-server/server/index.js
SERVER
chmod +x "${APP_DIR}/Contents/MacOS/godmode-server"

# The launcher. Its whole job: make sure the server answers, then put a window in front of it.
cat > "${APP_DIR}/Contents/MacOS/${APP_NAME}" <<LAUNCHER
#!/bin/bash
set -uo pipefail

REPO="${REPO}"
NODE_BIN="${NODE_BIN}"
PORT="${PORT}"
URL="${URL}"
AGENT_LABEL="${AGENT_LABEL}"

fail() {
  osascript -e "display dialog \"\$1\" with title \"GodMode\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1
  exit 1
}

if [[ ! -f "\${REPO}/dist-server/server/index.js" ]]; then
  fail "GodMode cannot find its code at \${REPO}. If you moved or deleted the repository, run scripts/install-macos-app.sh again from its new location."
fi

answering() { curl -sf -o /dev/null --max-time 2 "\${URL}/api/snapshot" 2>/dev/null || [[ \$? -eq 22 ]]; }

# The LaunchAgent normally already holds the server. If it does not — first run after an
# install, or it was stopped by hand — start it and wait. Only one process may hold the
# database lock, so this never starts a second one on top of a running server.
if ! answering; then
  launchctl kickstart "gui/\$(id -u)/\${AGENT_LABEL}" >/dev/null 2>&1 || \
    ( GODMODE_SERVER_PORT="\${PORT}" nohup "\$(dirname "\${BASH_SOURCE[0]}")/godmode-server" \
      >> "\${HOME}/Library/Logs/godmode.log" 2>&1 & )
  for _ in \$(seq 1 50); do
    answering && break
    sleep 0.2
  done
fi

answering || fail "The GodMode server did not start. See ~/Library/Logs/godmode.log."

# A chromeless window if a Chrome-family browser is here, otherwise the default browser. Both
# reach the same app at the same URL; --app just drops the tab bar and address bar.
for browser in "/Applications/Google Chrome.app" "/Applications/Brave Browser.app" "/Applications/Microsoft Edge.app"; do
  if [[ -d "\${browser}" ]]; then
    open -na "\${browser}" --args --app="\${URL}"
    exit 0
  fi
done
open "\${URL}"
LAUNCHER

chmod +x "${APP_DIR}/Contents/MacOS/${APP_NAME}"
touch "${APP_DIR}"

# ── The LaunchAgent ─────────────────────────────────────────────────────────────────────────

say "Installing the background server (${AGENT_LABEL})"
mkdir -p "$(dirname "${AGENT_PLIST}")" "${LOG_DIR}"

cat > "${AGENT_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <!-- The wrapper, not node directly: it is what supplies GODMODE_TOKEN without writing the
       secret into this file. See the note where it is generated. -->
  <key>ProgramArguments</key>
  <array>
    <string>${APP_DIR}/Contents/MacOS/godmode-server</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GODMODE_SERVER_PORT</key><string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <!-- Crash-looping against a held database lock would fill the log in seconds. -->
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>
PLIST

plutil -lint "${AGENT_PLIST}" >/dev/null || die "The LaunchAgent plist is malformed."
plutil -lint "${APP_DIR}/Contents/Info.plist" >/dev/null || die "The Info.plist is malformed."
bash -n "${APP_DIR}/Contents/MacOS/${APP_NAME}" || die "The generated launcher is not valid bash."
bash -n "${APP_DIR}/Contents/MacOS/godmode-server" || die "The generated server wrapper is not valid bash."
# The secret must not have been baked into anything this writes.
if grep -rqI "$("${NODE_BIN}" "${REPO}/dist-server/server/index.js" token 2>/dev/null || echo '__no_token__')" \
     "${APP_DIR}" "${AGENT_PLIST}" 2>/dev/null; then
  die "The token was written into the app bundle or the LaunchAgent. Refusing to install."
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  echo
  say "Dry run complete. Wrote:"
  echo "  ${APP_DIR}"
  echo "  ${AGENT_PLIST}"
  echo "Nothing was loaded into launchd and no server was started."
  exit 0
fi

launchctl bootout "gui/$(id -u)/${AGENT_LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${AGENT_PLIST}"

say "Waiting for the server"
for _ in $(seq 1 50); do
  # 401 means it is up and refusing an unauthenticated request, which is a success here.
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${URL}/api/snapshot" || true)"
  [[ "${status}" == "200" || "${status}" == "401" ]] && break
  sleep 0.2
done

echo
if [[ "${status:-}" == "200" || "${status:-}" == "401" ]]; then
  say "Running at ${URL}"
else
  say "The server has not answered yet — check ${LOG_FILE}"
fi

cat <<DONE

  ${APP_NAME} is in /Applications. Open it from Spotlight or the Dock.

  The server now starts automatically when you log in, and restarts if it stops.
  Sign in once with the token from \`npm run token\`; it is remembered across
  restarts now, so this should be the last time.

  Log:        ${LOG_FILE}
  Data:       ~/Library/Application Support/godmode/
  Uninstall:  scripts/install-macos-app.sh --uninstall

  Rebuilding (\`npm run build && npm run build:server\`) updates the installed app.
  Restart the server afterwards with:
    launchctl kickstart -k gui/$(id -u)/${AGENT_LABEL}

DONE
