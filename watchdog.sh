#!/usr/bin/env bash
set -u
set -o pipefail

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
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_GATEWAY_LOG="${OPENCLAW_GATEWAY_LOG:-$HOME/.openclaw/logs/gateway.log}"
OPENCLAW_WATCHDOG_LOG="${OPENCLAW_WATCHDOG_LOG:-$HOME/.openclaw/logs/watchdog.log}"
OPENCLAW_WATCHDOG_ERR_LOG="${OPENCLAW_WATCHDOG_ERR_LOG:-$HOME/.openclaw/logs/watchdog.err.log}"
OPENCLAW_WATCHDOG_RUNTIME_DIR="${OPENCLAW_WATCHDOG_RUNTIME_DIR:-$HOME/.openclaw/watchdog}"
OPENCLAW_WATCHDOG_INTERVAL_SECONDS="${OPENCLAW_WATCHDOG_INTERVAL_SECONDS:-3}"
OPENCLAW_HEALTH_CHECK_INTERVAL_SECONDS="${OPENCLAW_HEALTH_CHECK_INTERVAL_SECONDS:-30}"
OPENCLAW_RESTART_WINDOW_SECONDS="${OPENCLAW_RESTART_WINDOW_SECONDS:-60}"
OPENCLAW_RESTART_MAX_IN_WINDOW="${OPENCLAW_RESTART_MAX_IN_WINDOW:-3}"
OPENCLAW_RESTART_COOLDOWN_SECONDS="${OPENCLAW_RESTART_COOLDOWN_SECONDS:-300}"
OPENCLAW_LOG_ROTATE_MAX_BYTES="${OPENCLAW_LOG_ROTATE_MAX_BYTES:-52428800}"
OPENCLAW_LOG_ROTATE_KEEP="${OPENCLAW_LOG_ROTATE_KEEP:-5}"
OPENCLAW_ALERT_WEBHOOK_URL="${OPENCLAW_ALERT_WEBHOOK_URL:-}"
OPENCLAW_ALERT_TELEGRAM_BOT_TOKEN="${OPENCLAW_ALERT_TELEGRAM_BOT_TOKEN:-}"
OPENCLAW_ALERT_TELEGRAM_CHAT_ID="${OPENCLAW_ALERT_TELEGRAM_CHAT_ID:-}"
OPENCLAW_ALERT_TIMEOUT_SECONDS="${OPENCLAW_ALERT_TIMEOUT_SECONDS:-8}"
OPENCLAW_ALERT_DEDUP_WINDOW_SECONDS="${OPENCLAW_ALERT_DEDUP_WINDOW_SECONDS:-120}"

RESTART_STATE_FILE="${OPENCLAW_WATCHDOG_RUNTIME_DIR}/restart-epochs.log"
STATE_FILE="${OPENCLAW_WATCHDOG_RUNTIME_DIR}/state.env"
LOCK_DIR="${OPENCLAW_WATCHDOG_RUNTIME_DIR}/lock"
LOCK_PID_FILE="${LOCK_DIR}/pid"
ALERT_STATE_DIR="${OPENCLAW_WATCHDOG_RUNTIME_DIR}/alerts"
LOG_FOLLOW_PID=""

WATCHDOG_STATUS="starting"
WATCHDOG_LAST_LOOP_AT=""
WATCHDOG_LAST_HEALTH_CHECK_AT=""
WATCHDOG_LAST_HEALTH_RESULT="unknown"
WATCHDOG_LAST_RECOVERY_AT=""
WATCHDOG_LAST_RECOVERY_MODE=""
WATCHDOG_LAST_INCIDENT_AT=""
WATCHDOG_LAST_ERROR_CODE=""
WATCHDOG_RESTART_COUNT_WINDOW=0
WATCHDOG_COOLDOWN_UNTIL=""

ts() {
  date "+%Y-%m-%dT%H:%M:%S%z"
}

log_info() {
  printf "%s [watchdog] %s\n" "$(ts)" "$*"
}

log_warn() {
  printf "%s [watchdog][warn] %s\n" "$(ts)" "$*"
}

log_error() {
  printf "%s [watchdog][error] %s\n" "$(ts)" "$*" >&2
}

ensure_paths() {
  mkdir -p "$(dirname "${OPENCLAW_GATEWAY_LOG}")"
  mkdir -p "${OPENCLAW_WATCHDOG_RUNTIME_DIR}"
  mkdir -p "${ALERT_STATE_DIR}"
  touch "${OPENCLAW_GATEWAY_LOG}"
  touch "${OPENCLAW_WATCHDOG_LOG}"
  touch "${OPENCLAW_WATCHDOG_ERR_LOG}"
  touch "${RESTART_STATE_FILE}"
  touch "${STATE_FILE}"
}

iso_from_epoch() {
  local epoch="$1"
  if [[ -z "${epoch}" ]]; then
    return 0
  fi
  date -r "${epoch}" "+%Y-%m-%dT%H:%M:%S%z"
}

refresh_restart_count_window() {
  local now
  local epoch
  local count=0
  now="$(date +%s)"

  while IFS= read -r epoch; do
    [[ -z "${epoch}" ]] && continue
    [[ "${epoch}" =~ ^[0-9]+$ ]] || continue
    if (( now - epoch <= OPENCLAW_RESTART_WINDOW_SECONDS )); then
      count=$((count + 1))
    fi
  done < "${RESTART_STATE_FILE}"

  WATCHDOG_RESTART_COUNT_WINDOW="${count}"
}

persist_state() {
  local tmp_file
  WATCHDOG_LAST_LOOP_AT="$(ts)"
  refresh_restart_count_window
  tmp_file="$(mktemp "${OPENCLAW_WATCHDOG_RUNTIME_DIR}/state.env.XXXXXX")"
  {
    echo "WATCHDOG_STATUS=${WATCHDOG_STATUS}"
    echo "WATCHDOG_LAST_LOOP_AT=${WATCHDOG_LAST_LOOP_AT}"
    echo "WATCHDOG_LAST_HEALTH_CHECK_AT=${WATCHDOG_LAST_HEALTH_CHECK_AT}"
    echo "WATCHDOG_LAST_HEALTH_RESULT=${WATCHDOG_LAST_HEALTH_RESULT}"
    echo "WATCHDOG_LAST_RECOVERY_AT=${WATCHDOG_LAST_RECOVERY_AT}"
    echo "WATCHDOG_LAST_RECOVERY_MODE=${WATCHDOG_LAST_RECOVERY_MODE}"
    echo "WATCHDOG_LAST_INCIDENT_AT=${WATCHDOG_LAST_INCIDENT_AT}"
    echo "WATCHDOG_LAST_ERROR_CODE=${WATCHDOG_LAST_ERROR_CODE}"
    echo "WATCHDOG_RESTART_COUNT_WINDOW=${WATCHDOG_RESTART_COUNT_WINDOW}"
    echo "WATCHDOG_COOLDOWN_UNTIL=${WATCHDOG_COOLDOWN_UNTIL}"
    echo "WATCHDOG_PID=$$"
  } > "${tmp_file}"
  mv "${tmp_file}" "${STATE_FILE}"
}

acquire_lock() {
  local existing_pid

  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "$$" > "${LOCK_PID_FILE}"
    return 0
  fi

  if [[ -f "${LOCK_PID_FILE}" ]]; then
    existing_pid="$(cat "${LOCK_PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${existing_pid}" ]] && [[ "${existing_pid}" =~ ^[0-9]+$ ]] && kill -0 "${existing_pid}" 2>/dev/null; then
      log_warn "another watchdog instance is running (pid=${existing_pid}); exiting"
      exit 0
    fi
  fi

  rm -rf "${LOCK_DIR}" 2>/dev/null || true
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "$$" > "${LOCK_PID_FILE}"
    return 0
  fi

  log_error "failed to acquire watchdog lock"
  exit 1
}

release_lock() {
  local lock_pid
  lock_pid="$(cat "${LOCK_PID_FILE}" 2>/dev/null || true)"
  if [[ "${lock_pid}" == "$$" ]]; then
    rm -rf "${LOCK_DIR}" 2>/dev/null || true
  fi
}

rotate_file_if_needed() {
  local file="$1"
  local size=0
  local stamp
  local keep_from
  local old

  [[ -f "${file}" ]] || return 0

  size="$(wc -c < "${file}" 2>/dev/null || echo 0)"
  if [[ -z "${size}" ]]; then
    size=0
  fi
  if (( size < OPENCLAW_LOG_ROTATE_MAX_BYTES )); then
    return 0
  fi

  stamp="$(date "+%Y%m%d-%H%M%S")"
  mv "${file}" "${file}.${stamp}"
  : > "${file}"
  log_warn "rotated log ${file} (size=${size} bytes)"

  keep_from=$((OPENCLAW_LOG_ROTATE_KEEP + 1))
  while IFS= read -r old; do
    rm -f "${old}"
  done < <(ls -1t "${file}".* 2>/dev/null | tail -n +"${keep_from}")
}

start_log_follower() {
  if [[ -n "${LOG_FOLLOW_PID}" ]] && kill -0 "${LOG_FOLLOW_PID}" 2>/dev/null; then
    return 0
  fi

  tail -n 0 -F "${OPENCLAW_GATEWAY_LOG}" 2>/dev/null | while IFS= read -r line; do
    printf "%s [openclaw-log] %s\n" "$(ts)" "${line}"
  done &
  LOG_FOLLOW_PID="$!"
  log_info "started openclaw log follower (pid=${LOG_FOLLOW_PID})"
}

stop_log_follower() {
  if [[ -n "${LOG_FOLLOW_PID}" ]]; then
    kill "${LOG_FOLLOW_PID}" 2>/dev/null || true
    LOG_FOLLOW_PID=""
  fi
}

cleanup() {
  WATCHDOG_STATUS="stopped"
  persist_state
  stop_log_follower
  release_lock
}

sanitize_alert_key() {
  local raw="$1"
  echo "${raw}" | tr -cs 'A-Za-z0-9._-' '_'
}

should_emit_alert() {
  local key="$1"
  local key_file
  local now
  local last=0

  key_file="${ALERT_STATE_DIR}/$(sanitize_alert_key "${key}").ts"
  now="$(date +%s)"
  if [[ -f "${key_file}" ]]; then
    last="$(cat "${key_file}" 2>/dev/null || echo 0)"
    if [[ "${last}" =~ ^[0-9]+$ ]] && (( now - last < OPENCLAW_ALERT_DEDUP_WINDOW_SECONDS )); then
      return 1
    fi
  fi

  echo "${now}" > "${key_file}"
  return 0
}

send_alert() {
  local level="$1"
  local key="$2"
  local text="$3"
  local host
  local stamp
  local alert_text
  local payload
  local urlencoded_text

  if [[ -z "${OPENCLAW_ALERT_WEBHOOK_URL}" && ( -z "${OPENCLAW_ALERT_TELEGRAM_BOT_TOKEN}" || -z "${OPENCLAW_ALERT_TELEGRAM_CHAT_ID}" ) ]]; then
    return 0
  fi

  if ! should_emit_alert "${key}"; then
    return 0
  fi

  host="$(hostname 2>/dev/null || echo unknown-host)"
  stamp="$(ts)"
  alert_text="[openclaw-watchdog][${level}] ${text} | host=${host} | time=${stamp}"

  if [[ -n "${OPENCLAW_ALERT_TELEGRAM_BOT_TOKEN}" && -n "${OPENCLAW_ALERT_TELEGRAM_CHAT_ID}" ]]; then
    if ! curl -fsS --max-time "${OPENCLAW_ALERT_TIMEOUT_SECONDS}" \
      -X POST "https://api.telegram.org/bot${OPENCLAW_ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${OPENCLAW_ALERT_TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${alert_text}" >/dev/null 2>&1; then
      log_warn "telegram alert delivery failed (${key})"
    fi
  fi

  if [[ -n "${OPENCLAW_ALERT_WEBHOOK_URL}" ]]; then
    payload="$("${OPENCLAW_NODE_BIN}" -e '
const [level, key, text, host, stamp] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ level, key, text, host, stamp }));
' "${level}" "${key}" "${text}" "${host}" "${stamp}" 2>/dev/null || true)"

    if [[ -n "${payload}" ]]; then
      if ! curl -fsS --max-time "${OPENCLAW_ALERT_TIMEOUT_SECONDS}" \
        -H "Content-Type: application/json" \
        -d "${payload}" "${OPENCLAW_ALERT_WEBHOOK_URL}" >/dev/null 2>&1; then
        log_warn "webhook alert delivery failed (${key})"
      fi
    else
      urlencoded_text="${alert_text}"
      if ! curl -fsS --max-time "${OPENCLAW_ALERT_TIMEOUT_SECONDS}" \
        -X POST "${OPENCLAW_ALERT_WEBHOOK_URL}" \
        --data-urlencode "message=${urlencoded_text}" >/dev/null 2>&1; then
        log_warn "webhook alert delivery failed (${key})"
      fi
    fi
  fi
}

is_gateway_running() {
  local launch_row
  local launch_pid

  launch_row="$(launchctl list | awk -v label="${OPENCLAW_GATEWAY_LABEL}" '$3 == label { print $1; exit }')"
  if [[ -z "${launch_row}" || "${launch_row}" == "-" ]]; then
    return 1
  fi

  if ! [[ "${launch_row}" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  launch_pid="${launch_row}"
  if (( launch_pid <= 0 )); then
    return 1
  fi

  kill -0 "${launch_pid}" 2>/dev/null
}

health_check_gateway() {
  "${OPENCLAW_NODE_BIN}" "${OPENCLAW_CLI}" gateway health --timeout 5000 >/dev/null 2>&1
}

record_restart_and_check_backoff() {
  local now
  local kept=0
  local epoch
  local tmp_file

  now="$(date +%s)"
  tmp_file="$(mktemp "${OPENCLAW_WATCHDOG_RUNTIME_DIR}/restart-epochs.XXXXXX")"

  while IFS= read -r epoch; do
    [[ -z "${epoch}" ]] && continue
    if ! [[ "${epoch}" =~ ^[0-9]+$ ]]; then
      continue
    fi
    if (( now - epoch <= OPENCLAW_RESTART_WINDOW_SECONDS )); then
      echo "${epoch}" >> "${tmp_file}"
      kept=$((kept + 1))
    fi
  done < "${RESTART_STATE_FILE}"

  if (( kept >= OPENCLAW_RESTART_MAX_IN_WINDOW )); then
    mv "${tmp_file}" "${RESTART_STATE_FILE}"
    return 1
  fi

  echo "${now}" >> "${tmp_file}"
  mv "${tmp_file}" "${RESTART_STATE_FILE}"
  return 0
}

restart_gateway() {
  local gateway_plist
  gateway_plist="${HOME}/Library/LaunchAgents/${OPENCLAW_GATEWAY_LABEL}.plist"

  log_warn "gateway unavailable; trying openclaw gateway restart"
  send_alert "warn" "gateway-unavailable" "gateway unavailable; attempting restart"
  if "${OPENCLAW_NODE_BIN}" "${OPENCLAW_CLI}" gateway restart >/dev/null 2>&1; then
    sleep 2
    if is_gateway_running; then
      log_info "gateway restart succeeded via CLI"
      send_alert "info" "gateway-recovered-cli" "gateway recovered via CLI restart"
      WATCHDOG_LAST_RECOVERY_AT="$(ts)"
      WATCHDOG_LAST_RECOVERY_MODE="cli"
      WATCHDOG_LAST_ERROR_CODE=""
      return 0
    fi
    log_warn "CLI restart returned success but gateway still down"
  fi

  log_warn "CLI restart failed; trying launchctl kickstart fallback"
  if launchctl kickstart -k "gui/${UID}/${OPENCLAW_GATEWAY_LABEL}" >/dev/null 2>&1; then
    sleep 2
    if is_gateway_running; then
      log_info "gateway restart succeeded via launchctl kickstart"
      send_alert "info" "gateway-recovered-kickstart" "gateway recovered via launchctl kickstart"
      WATCHDOG_LAST_RECOVERY_AT="$(ts)"
      WATCHDOG_LAST_RECOVERY_MODE="kickstart"
      WATCHDOG_LAST_ERROR_CODE=""
      return 0
    fi
    log_warn "launchctl kickstart returned success but gateway still down"
  fi

  log_warn "trying force reinstall of gateway service"
  if "${OPENCLAW_NODE_BIN}" "${OPENCLAW_CLI}" gateway install --force --runtime node --port "${OPENCLAW_GATEWAY_PORT}" >/dev/null 2>&1; then
    launchctl bootstrap "gui/${UID}" "${gateway_plist}" >/dev/null 2>&1 || true
    launchctl enable "gui/${UID}/${OPENCLAW_GATEWAY_LABEL}" >/dev/null 2>&1 || true
    launchctl kickstart -k "gui/${UID}/${OPENCLAW_GATEWAY_LABEL}" >/dev/null 2>&1 || true
    sleep 2
    if is_gateway_running; then
      log_info "gateway recovered after force reinstall"
      send_alert "info" "gateway-recovered-reinstall" "gateway recovered after force reinstall"
      WATCHDOG_LAST_RECOVERY_AT="$(ts)"
      WATCHDOG_LAST_RECOVERY_MODE="reinstall"
      WATCHDOG_LAST_ERROR_CODE=""
      return 0
    fi
  fi

  log_error "gateway restart failed in both CLI and launchctl fallback"
  send_alert "error" "gateway-restart-failed" "gateway restart failed in all recovery paths"
  WATCHDOG_LAST_ERROR_CODE="gateway_restart_failed"
  return 1
}

main() {
  local now
  local next_health_epoch
  local cooldown_until_epoch

  trap cleanup EXIT INT TERM

  ensure_paths
  acquire_lock
  start_log_follower
  log_info "watchdog started (gateway label=${OPENCLAW_GATEWAY_LABEL}, port=${OPENCLAW_GATEWAY_PORT})"
  send_alert "info" "watchdog-started" "watchdog started (label=${OPENCLAW_GATEWAY_LABEL}, port=${OPENCLAW_GATEWAY_PORT})"
  WATCHDOG_STATUS="idle"
  WATCHDOG_LAST_ERROR_CODE=""
  WATCHDOG_COOLDOWN_UNTIL=""
  persist_state
  next_health_epoch=0

  while true; do
    rotate_file_if_needed "${OPENCLAW_GATEWAY_LOG}"
    rotate_file_if_needed "${OPENCLAW_WATCHDOG_LOG}"
    rotate_file_if_needed "${OPENCLAW_WATCHDOG_ERR_LOG}"
    WATCHDOG_STATUS="idle"
    persist_state

    if ! is_gateway_running; then
      log_warn "detected gateway not running"
      WATCHDOG_STATUS="recovering"
      WATCHDOG_LAST_INCIDENT_AT="$(ts)"
      WATCHDOG_LAST_ERROR_CODE="gateway_down_detected"
      persist_state
      if record_restart_and_check_backoff; then
        if restart_gateway; then
          WATCHDOG_STATUS="idle"
        else
          WATCHDOG_STATUS="degraded"
        fi
        persist_state
      else
        log_error "too many restarts within ${OPENCLAW_RESTART_WINDOW_SECONDS}s; cooldown ${OPENCLAW_RESTART_COOLDOWN_SECONDS}s"
        send_alert "error" "gateway-restart-cooldown" "too many restarts; entering cooldown ${OPENCLAW_RESTART_COOLDOWN_SECONDS}s"
        WATCHDOG_STATUS="cooldown"
        WATCHDOG_LAST_ERROR_CODE="gateway_restart_cooldown"
        cooldown_until_epoch=$(( $(date +%s) + OPENCLAW_RESTART_COOLDOWN_SECONDS ))
        WATCHDOG_COOLDOWN_UNTIL="$(iso_from_epoch "${cooldown_until_epoch}")"
        persist_state
        sleep "${OPENCLAW_RESTART_COOLDOWN_SECONDS}"
        WATCHDOG_STATUS="idle"
        WATCHDOG_COOLDOWN_UNTIL=""
        persist_state
      fi
      sleep "${OPENCLAW_WATCHDOG_INTERVAL_SECONDS}"
      continue
    fi

    now="$(date +%s)"
    if (( now >= next_health_epoch )); then
      WATCHDOG_LAST_HEALTH_CHECK_AT="$(ts)"
      if ! health_check_gateway; then
        WATCHDOG_LAST_HEALTH_RESULT="fail"
        log_warn "health probe failed while process exists"
        send_alert "warn" "gateway-health-failed" "health probe failed while process exists"
        WATCHDOG_STATUS="recovering"
        WATCHDOG_LAST_INCIDENT_AT="$(ts)"
        WATCHDOG_LAST_ERROR_CODE="gateway_health_failed"
        persist_state
        if record_restart_and_check_backoff; then
          if restart_gateway; then
            WATCHDOG_STATUS="idle"
          else
            WATCHDOG_STATUS="degraded"
          fi
          persist_state
        else
          log_error "health probe restart suppressed by backoff; cooldown ${OPENCLAW_RESTART_COOLDOWN_SECONDS}s"
          send_alert "error" "gateway-health-cooldown" "health probe restart suppressed; entering cooldown ${OPENCLAW_RESTART_COOLDOWN_SECONDS}s"
          WATCHDOG_STATUS="cooldown"
          WATCHDOG_LAST_ERROR_CODE="gateway_health_cooldown"
          cooldown_until_epoch=$(( $(date +%s) + OPENCLAW_RESTART_COOLDOWN_SECONDS ))
          WATCHDOG_COOLDOWN_UNTIL="$(iso_from_epoch "${cooldown_until_epoch}")"
          persist_state
          sleep "${OPENCLAW_RESTART_COOLDOWN_SECONDS}"
          WATCHDOG_STATUS="idle"
          WATCHDOG_COOLDOWN_UNTIL=""
          persist_state
        fi
      else
        WATCHDOG_LAST_HEALTH_RESULT="ok"
        WATCHDOG_LAST_ERROR_CODE=""
        persist_state
      fi
      next_health_epoch=$((now + OPENCLAW_HEALTH_CHECK_INTERVAL_SECONDS))
    fi

    sleep "${OPENCLAW_WATCHDOG_INTERVAL_SECONDS}"
  done
}

main "$@"
