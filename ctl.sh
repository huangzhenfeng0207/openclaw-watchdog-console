#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi

OPENCLAW_NODE_BIN="${OPENCLAW_NODE_BIN:-/opt/homebrew/opt/node/bin/node}"
OPENCLAW_CLI="${OPENCLAW_CLI:-/Users/huangzhenfeng/openclaw/openclaw.mjs}"
OPENCLAW_GATEWAY_LABEL="${OPENCLAW_GATEWAY_LABEL:-ai.openclaw.gateway}"
OPENCLAW_WATCHDOG_LABEL="${OPENCLAW_WATCHDOG_LABEL:-ai.openclaw.watchdog}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_BACKUP_DIR="${OPENCLAW_BACKUP_DIR:-${SCRIPT_DIR}/backups}"
OPENCLAW_POSTBOOT_TIMEOUT_SECONDS="${OPENCLAW_POSTBOOT_TIMEOUT_SECONDS:-90}"
OPENCLAW_POSTBOOT_INTERVAL_SECONDS="${OPENCLAW_POSTBOOT_INTERVAL_SECONDS:-3}"

WATCHDOG_PLIST="${HOME}/Library/LaunchAgents/${OPENCLAW_WATCHDOG_LABEL}.plist"
WATCHDOG_LOG="${HOME}/.openclaw/logs/watchdog.log"
WATCHDOG_ERR_LOG="${HOME}/.openclaw/logs/watchdog.err.log"
GATEWAY_LOG="${HOME}/.openclaw/logs/gateway.log"
GATEWAY_ERR_LOG="${HOME}/.openclaw/logs/gateway.err.log"

usage() {
  cat <<USAGE
Usage: $0 <command>

Commands:
  install                 install/refresh gateway+watchdog launchd services
  start                   start gateway and watchdog
  stop                    stop watchdog then gateway
  restart                 restart gateway and watchdog
  status                  show current runtime status
  postboot-check [sec]    wait-and-verify post-boot readiness
  backup                  snapshot scripts + plist for rollback
  rollback [id]           restore snapshot (default: latest)
  list-backups            list available snapshot ids
  logs                    tail watchdog + gateway logs
  test-chat [message]     send one test message to OpenClaw (default: watchdog在线吗)
USAGE
}

service_pid() {
  local label="$1"
  launchctl list | awk -v target="${label}" '$3 == target { print $1; exit }'
}

service_running() {
  local pid
  pid="$(service_pid "$1")"
  [[ -n "${pid}" && "${pid}" != "-" && "${pid}" =~ ^[0-9]+$ ]] || return 1
  (( pid > 0 )) || return 1
  kill -0 "${pid}" 2>/dev/null
}

start_services() {
  "${OPENCLAW_NODE_BIN}" "${OPENCLAW_CLI}" gateway start >/dev/null 2>&1 || true
  launchctl enable "gui/${UID}/${OPENCLAW_WATCHDOG_LABEL}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/${UID}/${OPENCLAW_WATCHDOG_LABEL}" >/dev/null 2>&1 || true
}

stop_services() {
  launchctl bootout "gui/${UID}/${OPENCLAW_WATCHDOG_LABEL}" >/dev/null 2>&1 || true
  "${OPENCLAW_NODE_BIN}" "${OPENCLAW_CLI}" gateway stop >/dev/null 2>&1 || true
}

restart_services() {
  "${OPENCLAW_NODE_BIN}" "${OPENCLAW_CLI}" gateway restart >/dev/null 2>&1 || true
  if [[ -f "${WATCHDOG_PLIST}" ]]; then
    launchctl bootout "gui/${UID}" "${WATCHDOG_PLIST}" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/${UID}" "${WATCHDOG_PLIST}" >/dev/null 2>&1 || true
    launchctl enable "gui/${UID}/${OPENCLAW_WATCHDOG_LABEL}" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/${UID}/${OPENCLAW_WATCHDOG_LABEL}" >/dev/null 2>&1 || true
  fi
}

show_status() {
  echo "== launchd =="
  launchctl list | rg "${OPENCLAW_GATEWAY_LABEL}|${OPENCLAW_WATCHDOG_LABEL}" || true
  echo
  echo "== gateway port ${OPENCLAW_GATEWAY_PORT} =="
  lsof -nP -iTCP:"${OPENCLAW_GATEWAY_PORT}" -sTCP:LISTEN || true
  echo
  echo "== watchdog log tail =="
  tail -n 20 "${WATCHDOG_LOG}" 2>/dev/null || true
  echo
  echo "== gateway log tail =="
  tail -n 20 "${GATEWAY_LOG}" 2>/dev/null || true
  echo
  echo "== error logs tail =="
  echo "-- watchdog.err.log --"
  tail -n 10 "${WATCHDOG_ERR_LOG}" 2>/dev/null || true
  echo "-- gateway.err.log --"
  tail -n 10 "${GATEWAY_ERR_LOG}" 2>/dev/null || true
}

postboot_check() {
  local timeout
  local interval
  local start_ts
  local now_ts
  local elapsed

  timeout="${1:-${OPENCLAW_POSTBOOT_TIMEOUT_SECONDS}}"
  interval="${OPENCLAW_POSTBOOT_INTERVAL_SECONDS}"
  start_ts="$(date +%s)"

  echo "postboot-check: timeout=${timeout}s interval=${interval}s"

  while true; do
    if service_running "${OPENCLAW_GATEWAY_LABEL}" \
      && service_running "${OPENCLAW_WATCHDOG_LABEL}" \
      && lsof -nP -iTCP:"${OPENCLAW_GATEWAY_PORT}" -sTCP:LISTEN >/dev/null 2>&1 \
      && "${OPENCLAW_NODE_BIN}" "${OPENCLAW_CLI}" gateway health --timeout 5000 >/dev/null 2>&1; then
      echo "postboot-check: PASS"
      show_status
      return 0
    fi

    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    if (( elapsed >= timeout )); then
      echo "postboot-check: FAIL (timeout ${timeout}s)"
      show_status
      return 1
    fi

    sleep "${interval}"
  done
}

backup_snapshot() {
  local snapshot_id
  local snapshot_dir
  local f
  local project_files=(
    "watchdog.sh"
    "install.sh"
    "ctl.sh"
    "chat-with-openclaw.sh"
    "ai.openclaw.watchdog.plist"
    "README.md"
    ".env.example"
    "TECHNICAL_PLAN.md"
  )
  local tar_inputs=()
  local launch_inputs=()

  snapshot_id="$(date "+%Y%m%d-%H%M%S")"
  snapshot_dir="${OPENCLAW_BACKUP_DIR}/${snapshot_id}"
  mkdir -p "${snapshot_dir}"

  for f in "${project_files[@]}"; do
    if [[ -f "${SCRIPT_DIR}/${f}" ]]; then
      tar_inputs+=("${f}")
    fi
  done
  if [[ -f "${SCRIPT_DIR}/.env" ]]; then
    tar_inputs+=(".env")
  fi

  if (( ${#tar_inputs[@]} > 0 )); then
    tar -czf "${snapshot_dir}/project.tar.gz" -C "${SCRIPT_DIR}" "${tar_inputs[@]}"
  fi

  if [[ -f "${HOME}/Library/LaunchAgents/${OPENCLAW_WATCHDOG_LABEL}.plist" ]]; then
    launch_inputs+=("${OPENCLAW_WATCHDOG_LABEL}.plist")
  fi
  if [[ -f "${HOME}/Library/LaunchAgents/${OPENCLAW_GATEWAY_LABEL}.plist" ]]; then
    launch_inputs+=("${OPENCLAW_GATEWAY_LABEL}.plist")
  fi
  if (( ${#launch_inputs[@]} > 0 )); then
    tar -czf "${snapshot_dir}/launchagents.tar.gz" -C "${HOME}/Library/LaunchAgents" "${launch_inputs[@]}"
  fi

  {
    echo "snapshot_id=${snapshot_id}"
    echo "created_at=$(date "+%Y-%m-%dT%H:%M:%S%z")"
    echo "cwd=${SCRIPT_DIR}"
  } > "${snapshot_dir}/meta.txt"

  echo "backup created: ${snapshot_id}"
  echo "path: ${snapshot_dir}"
}

latest_snapshot_id() {
  if [[ ! -d "${OPENCLAW_BACKUP_DIR}" ]]; then
    return 1
  fi
  ls -1 "${OPENCLAW_BACKUP_DIR}" 2>/dev/null | sort | tail -n 1
}

list_backups() {
  if [[ ! -d "${OPENCLAW_BACKUP_DIR}" ]]; then
    echo "no backups"
    return 0
  fi
  ls -1 "${OPENCLAW_BACKUP_DIR}" 2>/dev/null | sort || true
}

rollback_snapshot() {
  local snapshot_id="${1:-}"
  local snapshot_dir

  if [[ -z "${snapshot_id}" ]]; then
    snapshot_id="$(latest_snapshot_id || true)"
  fi
  if [[ -z "${snapshot_id}" ]]; then
    echo "no backup snapshot found"
    return 1
  fi

  snapshot_dir="${OPENCLAW_BACKUP_DIR}/${snapshot_id}"
  if [[ ! -d "${snapshot_dir}" ]]; then
    echo "snapshot not found: ${snapshot_id}"
    return 1
  fi

  if [[ -f "${snapshot_dir}/project.tar.gz" ]]; then
    tar -xzf "${snapshot_dir}/project.tar.gz" -C "${SCRIPT_DIR}"
  fi
  if [[ -f "${snapshot_dir}/launchagents.tar.gz" ]]; then
    mkdir -p "${HOME}/Library/LaunchAgents"
    tar -xzf "${snapshot_dir}/launchagents.tar.gz" -C "${HOME}/Library/LaunchAgents"
  fi

  chmod +x "${SCRIPT_DIR}/watchdog.sh" "${SCRIPT_DIR}/install.sh" "${SCRIPT_DIR}/ctl.sh" "${SCRIPT_DIR}/chat-with-openclaw.sh" 2>/dev/null || true
  "${SCRIPT_DIR}/install.sh"
  echo "rollback completed: ${snapshot_id}"
}

tail_logs() {
  echo "Tailing watchdog + gateway logs. Ctrl+C to exit."
  tail -n 80 -F "${WATCHDOG_LOG}" "${WATCHDOG_ERR_LOG}" "${GATEWAY_LOG}" "${GATEWAY_ERR_LOG}"
}

test_chat() {
  local message
  if [[ $# -gt 0 ]]; then
    message="$*"
  else
    message="watchdog在线吗"
  fi
  "${SCRIPT_DIR}/chat-with-openclaw.sh" "${message}"
}

cmd="${1:-}"
if [[ -z "${cmd}" ]]; then
  usage
  exit 1
fi
shift || true

case "${cmd}" in
  install)
    "${SCRIPT_DIR}/install.sh"
    ;;
  start)
    start_services
    show_status
    ;;
  stop)
    stop_services
    show_status
    ;;
  restart)
    restart_services
    show_status
    ;;
  status)
    show_status
    ;;
  postboot-check)
    postboot_check "$@"
    ;;
  backup)
    backup_snapshot
    ;;
  rollback)
    rollback_snapshot "$@"
    ;;
  list-backups)
    list_backups
    ;;
  logs)
    tail_logs
    ;;
  test-chat)
    test_chat "$@"
    ;;
  *)
    usage
    exit 1
    ;;
esac
