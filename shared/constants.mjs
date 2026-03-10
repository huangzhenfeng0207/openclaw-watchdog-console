export const APP_NAME = "OpenClaw Guardian";
export const APP_SUPPORT_NAME = "OpenClaw Guardian";
export const APP_LOG_NAME = "OpenClaw Guardian";
export const SUPERVISOR_LABEL = "ai.openclaw.guardian.supervisor";
export const SOCKET_NAME = "guardian.sock";
export const STATUS_FILE = "status.json";
export const CONFIG_FILE = "config.json";
export const INCIDENTS_FILE = "incidents.jsonl";
export const EXPORTS_DIR = "exports";
export const POLL_INTERVAL_MS = 3000;
export const HEALTH_STALE_MS = 10000;
export const AUTO_RECOVERY_COOLDOWN_MS = 15000;
export const LOG_LIMIT = 200;
export const REPAIR_ACTIONS = Object.freeze([
  "restart_gateway",
  "restart_supervisor",
  "reinstall_gateway_launchd",
  "reinstall_supervisor_launchd",
]);
export const STATUS_STATES = Object.freeze(["healthy", "degraded", "offline"]);
