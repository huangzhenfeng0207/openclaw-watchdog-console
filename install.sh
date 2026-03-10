#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
WATCHDOG_PLIST_DST="${USER_LAUNCH_AGENTS_DIR}/ai.openclaw.watchdog.plist"
WATCHDOG_LABEL="ai.openclaw.watchdog"
GATEWAY_LABEL="ai.openclaw.gateway"
OPENCLAW_NODE_BIN="${OPENCLAW_NODE_BIN:-/opt/homebrew/opt/node/bin/node}"
OPENCLAW_CLI="${OPENCLAW_CLI:-/Users/huangzhenfeng/openclaw/openclaw.mjs}"
OPENCLAW_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

log() {
  printf "%s [install] %s\n" "$(date "+%Y-%m-%dT%H:%M:%S%z")" "$*"
}

warn() {
  printf "%s [install][warn] %s\n" "$(date "+%Y-%m-%dT%H:%M:%S%z")" "$*" >&2
}

ensure_scripts_executable() {
  chmod +x "${SCRIPT_DIR}/watchdog.sh"
  chmod +x "${SCRIPT_DIR}/chat-with-openclaw.sh"
  chmod +x "${SCRIPT_DIR}/ctl.sh"
  chmod +x "${SCRIPT_DIR}/install.sh"
}

ensure_logs_dir() {
  mkdir -p "${HOME}/.openclaw/logs"
  touch "${HOME}/.openclaw/logs/watchdog.log"
  touch "${HOME}/.openclaw/logs/watchdog.err.log"
}

gateway_running() {
  local pid
  pid="$(launchctl list | awk -v label="${GATEWAY_LABEL}" '$3 == label { print $1; exit }')"
  if [[ -z "${pid}" || "${pid}" == "-" ]]; then
    return 1
  fi
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  (( pid > 0 )) || return 1
  kill -0 "${pid}" 2>/dev/null
}

port_listening() {
  lsof -nP -iTCP:"${OPENCLAW_PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

ensure_gateway_service() {
  if gateway_running && port_listening; then
    log "gateway service already healthy; skip reinstall"
  else
    log "gateway service not healthy; reinstall + restart"
    "${OPENCLAW_NODE_BIN}" "${OPENCLAW_CLI}" gateway install --force --runtime node --port "${OPENCLAW_PORT}"
    launchctl enable "gui/${UID}/${GATEWAY_LABEL}" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/${UID}/${GATEWAY_LABEL}" >/dev/null 2>&1 || true
  fi
}

render_watchdog_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${WATCHDOG_LABEL}</string>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>Umask</key>
    <integer>63</integer>

    <key>ProgramArguments</key>
    <array>
      <string>${SCRIPT_DIR}/watchdog.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>

    <key>StandardOutPath</key>
    <string>${HOME}/.openclaw/logs/watchdog.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.openclaw/logs/watchdog.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${HOME}</string>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
      <key>OPENCLAW_NODE_BIN</key>
      <string>${OPENCLAW_NODE_BIN}</string>
      <key>OPENCLAW_CLI</key>
      <string>${OPENCLAW_CLI}</string>
      <key>OPENCLAW_GATEWAY_LABEL</key>
      <string>${GATEWAY_LABEL}</string>
      <key>OPENCLAW_GATEWAY_PORT</key>
      <string>${OPENCLAW_PORT}</string>
      <key>OPENCLAW_WATCHDOG_HOME</key>
      <string>${SCRIPT_DIR}</string>
    </dict>
  </dict>
</plist>
EOF
}

install_watchdog_plist() {
  mkdir -p "${USER_LAUNCH_AGENTS_DIR}"
  render_watchdog_plist > "${WATCHDOG_PLIST_DST}"
  chmod 644 "${WATCHDOG_PLIST_DST}"
}

reload_watchdog_launchd() {
  launchctl bootout "gui/${UID}" "${WATCHDOG_PLIST_DST}" >/dev/null 2>&1 || true
  launchctl bootout "gui/${UID}/${WATCHDOG_LABEL}" >/dev/null 2>&1 || true

  if ! launchctl bootstrap "gui/${UID}" "${WATCHDOG_PLIST_DST}" >/dev/null 2>&1; then
    warn "launchctl bootstrap returned non-zero; fallback to existing loaded service"
  fi

  launchctl enable "gui/${UID}/${WATCHDOG_LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/${UID}/${WATCHDOG_LABEL}" >/dev/null 2>&1 || true
}

print_status() {
  log "launchd status:"
  launchctl list | rg "ai\\.openclaw\\.(gateway|watchdog)" || true

  log "gateway port listeners:"
  lsof -nP -iTCP:"${OPENCLAW_PORT}" -sTCP:LISTEN | sed -n '1,5p' || true

  log "watchdog log tail:"
  tail -n 20 "${HOME}/.openclaw/logs/watchdog.log" || true
}

main() {
  ensure_scripts_executable
  ensure_logs_dir
  ensure_gateway_service
  install_watchdog_plist
  reload_watchdog_launchd
  print_status
  log "done"
}

main "$@"
