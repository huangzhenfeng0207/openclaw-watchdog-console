import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = process.env.OPENCLAW_PROJECT_DIR || path.resolve(__dirname, "..", "..");
const RUNTIME_DIR = path.join(PROJECT_DIR, "runtime");
const EVENTS_FILE = path.join(RUNTIME_DIR, "console-events.jsonl");
const ENV_FILE = path.join(PROJECT_DIR, ".env");
const STATUS_CACHE_TTL_MS = 1500;
const WATCHDOG_STATE_STALE_MS = 15000;

function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    env[key] = value;
  }
  return env;
}

async function loadConfig() {
  const envText = await readFile(ENV_FILE, "utf8").catch(() => "");
  const fileEnv = parseEnv(envText);
  const merged = { ...fileEnv, ...process.env };
  return {
    rawEnv: merged,
    consolePort: Number(merged.OPENCLAW_CONSOLE_PORT || 18890),
    host: merged.OPENCLAW_CONSOLE_HOST || "127.0.0.1",
    nodeBin: merged.OPENCLAW_NODE_BIN || "/opt/homebrew/opt/node/bin/node",
    openclawCli: merged.OPENCLAW_CLI || "/Users/huangzhenfeng/openclaw/openclaw.mjs",
    gatewayLabel: merged.OPENCLAW_GATEWAY_LABEL || "ai.openclaw.gateway",
    watchdogLabel: merged.OPENCLAW_WATCHDOG_LABEL || "ai.openclaw.watchdog",
    consoleLabel: merged.OPENCLAW_CONSOLE_LABEL || "ai.openclaw.console",
    gatewayPort: Number(merged.OPENCLAW_GATEWAY_PORT || 18789),
    gatewayToken: merged.OPENCLAW_GATEWAY_TOKEN || "",
    agentId: merged.OPENCLAW_AGENT_ID || "main",
    backupsDir: merged.OPENCLAW_BACKUP_DIR || path.join(PROJECT_DIR, "backups"),
    watchdogLog: merged.OPENCLAW_WATCHDOG_LOG || path.join(process.env.HOME || "", ".openclaw/logs/watchdog.log"),
    watchdogErrLog:
      merged.OPENCLAW_WATCHDOG_ERR_LOG || path.join(process.env.HOME || "", ".openclaw/logs/watchdog.err.log"),
    gatewayLog: merged.OPENCLAW_GATEWAY_LOG || path.join(process.env.HOME || "", ".openclaw/logs/gateway.log"),
    gatewayErrLog:
      merged.OPENCLAW_GATEWAY_ERR_LOG || path.join(process.env.HOME || "", ".openclaw/logs/gateway.err.log"),
    watchdogStateFile:
      merged.OPENCLAW_WATCHDOG_STATE_FILE || path.join(process.env.HOME || "", ".openclaw/watchdog/state.env"),
    ctlPath: path.join(PROJECT_DIR, "ctl.sh"),
    chatPath: path.join(PROJECT_DIR, "chat-with-openclaw.sh"),
    serviceLog: path.join(process.env.HOME || "", ".openclaw/logs/console.log"),
    serviceErrLog: path.join(process.env.HOME || "", ".openclaw/logs/console.err.log"),
  };
}

const config = await loadConfig();

function nowIso() {
  return new Date().toISOString();
}

function parseTs(value) {
  if (!value) {
    return 0;
  }
  const normalized = String(value).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function makeRequestId() {
  return `req_${crypto.randomBytes(6).toString("hex")}`;
}

function baseEnv() {
  return {
    ...process.env,
    ...config.rawEnv,
    OPENCLAW_CONSOLE_PORT: String(config.consolePort),
  };
}

async function ensureRuntime() {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await appendFile(EVENTS_FILE, "").catch(() => undefined);
}

async function runCommand(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      env: baseEnv(),
      timeout: options.timeoutMs || 30000,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 2,
      cwd: PROJECT_DIR,
    });
    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: 0,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || "").trim(),
      code: Number.isInteger(error.code) ? error.code : 1,
      message: error.message || "command failed",
    };
  }
}

async function runOpenclaw(args, options = {}) {
  return runCommand(config.nodeBin, [config.openclawCli, ...args], options);
}

async function runCtl(args, options = {}) {
  return runCommand(config.ctlPath, args, options);
}

async function runChat(message) {
  return runCommand(config.chatPath, [message], {
    timeoutMs: 120000,
    maxBuffer: 1024 * 1024 * 4,
  });
}

function trimText(text, limit = 1200) {
  if (!text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n...[truncated]`;
}

let statusCache = {
  expiresAt: 0,
  value: null,
};

async function readStateEnv() {
  const text = await readFile(config.watchdogStateFile, "utf8").catch(() => "");
  return parseEnv(text);
}

async function tailLines(filePath, limit = 200) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/tail", ["-n", String(limit), filePath], { maxBuffer: 10 * 1024 * 1024 });
    if (!stdout.trim()) {
      return [];
    }
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function parseLaunchctlList(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const items = new Map();
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) {
      continue;
    }
    const [pidRaw, statusRaw, label] = parts;
    items.set(label, {
      label,
      pid: /^\d+$/.test(pidRaw) ? Number(pidRaw) : null,
      rawPid: pidRaw,
      statusRaw,
    });
  }
  return items;
}

async function getServiceMap() {
  const result = await runCommand("/bin/launchctl", ["list"]);
  if (!result.ok) {
    return new Map();
  }
  return parseLaunchctlList(result.stdout);
}

function normalizeService(service) {
  if (!service || !service.pid || service.pid <= 0) {
    return { status: "stopped", pid: null };
  }
  return { status: "running", pid: service.pid };
}

async function isPortListening(port) {
  const result = await runCommand("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return result.ok;
}

async function getGatewayHealth() {
  const args = ["gateway", "health", "--timeout", "5000"];
  if (config.gatewayToken) {
    args.push("--token", config.gatewayToken);
  }
  const result = await runOpenclaw(args, { timeoutMs: 10000 });
  return {
    ok: result.ok,
    message: result.ok ? "health check passed" : result.stderr || result.stdout || result.message || "health check failed",
  };
}

function buildOverallStatus({ gateway, watchdog, recovery }) {
  if (recovery.state === "cooldown") {
    return {
      status: "cooldown",
      summary: "Automatic recovery is paused because restart attempts exceeded the configured window.",
    };
  }
  if (recovery.state === "recovering") {
    return {
      status: "recovering",
      summary: "Watchdog is actively trying to recover OpenClaw.",
    };
  }
  if (gateway.status === "online" && watchdog.status === "running" && gateway.health === "ok") {
    return {
      status: "healthy",
      summary: "OpenClaw is online and watchdog is actively protecting the runtime.",
    };
  }
  if (gateway.status === "offline" && watchdog.status !== "running") {
    return {
      status: "offline",
      summary: "OpenClaw is offline and watchdog is not actively protecting the runtime.",
    };
  }
  return {
    status: "degraded",
    summary: "Core components are partially available and need attention.",
  };
}

function readJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readConsoleEvents(limit = 50) {
  const text = await readFile(EVENTS_FILE, "utf8").catch(() => "");
  return readJsonLines(text).slice(-limit);
}

async function appendConsoleEvent(event) {
  await ensureRuntime();
  await appendFile(EVENTS_FILE, `${JSON.stringify(event)}\n`);
}

function buildEvent({
  ts,
  level,
  source,
  category,
  type,
  title,
  message,
  incidentId = null,
  actionId = null,
}) {
  return {
    id: `evt_${crypto.randomBytes(6).toString("hex")}`,
    ts,
    level,
    source,
    category,
    type,
    title,
    message,
    incidentId,
    actionId,
  };
}

function extractTimestamp(line) {
  const firstSpace = line.indexOf(" ");
  if (firstSpace <= 0) {
    return nowIso();
  }
  return line.slice(0, firstSpace);
}

function parseWatchdogLogLine(line) {
  const ts = extractTimestamp(line);
  if (line.includes("[watchdog] watchdog started")) {
    return buildEvent({
      ts,
      level: "info",
      source: "watchdog",
      category: "lifecycle",
      type: "watchdog_started",
      title: "Watchdog Started",
      message: "Watchdog started and began monitoring OpenClaw.",
    });
  }
  if (line.includes("[watchdog][warn] detected gateway not running")) {
    return buildEvent({
      ts,
      level: "warn",
      source: "watchdog",
      category: "recovery",
      type: "gateway_down_detected",
      title: "Gateway Down Detected",
      message: "Watchdog detected that the OpenClaw gateway is not running.",
    });
  }
  if (line.includes("[watchdog][warn] health probe failed while process exists")) {
    return buildEvent({
      ts,
      level: "warn",
      source: "watchdog",
      category: "health",
      type: "gateway_health_failed",
      title: "Gateway Health Probe Failed",
      message: "Gateway process exists, but health probing failed.",
    });
  }
  if (line.includes("[watchdog][warn] gateway unavailable; trying openclaw gateway restart")) {
    return buildEvent({
      ts,
      level: "warn",
      source: "watchdog",
      category: "recovery",
      type: "restart_attempted",
      title: "Recovery Attempt Started",
      message: "Watchdog started an automated gateway restart attempt.",
    });
  }
  if (line.includes("[watchdog] gateway restart succeeded via CLI")) {
    return buildEvent({
      ts,
      level: "success",
      source: "watchdog",
      category: "recovery",
      type: "restart_succeeded",
      title: "Gateway Recovered",
      message: "Gateway restart succeeded through OpenClaw CLI.",
    });
  }
  if (line.includes("[watchdog] gateway restart succeeded via launchctl kickstart")) {
    return buildEvent({
      ts,
      level: "success",
      source: "watchdog",
      category: "recovery",
      type: "restart_succeeded",
      title: "Gateway Recovered",
      message: "Gateway restart succeeded through launchctl kickstart.",
    });
  }
  if (line.includes("[watchdog] gateway recovered after force reinstall")) {
    return buildEvent({
      ts,
      level: "success",
      source: "watchdog",
      category: "recovery",
      type: "restart_succeeded",
      title: "Gateway Recovered",
      message: "Gateway recovered after forced reinstall.",
    });
  }
  if (line.includes("[watchdog][error] too many restarts within")) {
    return buildEvent({
      ts,
      level: "error",
      source: "watchdog",
      category: "recovery",
      type: "cooldown_entered",
      title: "Cooldown Entered",
      message: "Too many restart attempts were detected, so automatic recovery entered cooldown.",
    });
  }
  if (line.includes("[watchdog][error] gateway restart failed in all recovery paths")) {
    return buildEvent({
      ts,
      level: "error",
      source: "watchdog",
      category: "recovery",
      type: "restart_failed",
      title: "Gateway Recovery Failed",
      message: "All configured recovery paths failed to bring OpenClaw back online.",
    });
  }
  if (line.includes("[openclaw-log]") && line.includes("[gateway] listening on ws://")) {
    return buildEvent({
      ts,
      level: "success",
      source: "gateway",
      category: "lifecycle",
      type: "gateway_online",
      title: "Gateway Online",
      message: "OpenClaw gateway is listening for connections.",
    });
  }
  if (line.includes("[openclaw-log]") && line.includes("[gateway] received SIGTERM; shutting down")) {
    return buildEvent({
      ts,
      level: "warn",
      source: "gateway",
      category: "lifecycle",
      type: "gateway_offline",
      title: "Gateway Shutting Down",
      message: "OpenClaw gateway received a shutdown signal and is exiting.",
    });
  }
  return null;
}

function parseActionOutput(action, stdout) {
  if (action === "test-chat") {
    const [rawJson = "", parsedReply = ""] = stdout.split("---- parsed-reply ----");
    let parsedMeta = null;
    try {
      const payload = JSON.parse(rawJson.trim());
      const meta = payload?.result?.meta || {};
      const agentMeta = meta.agentMeta || {};
      parsedMeta = {
        durationMs: meta.durationMs ?? null,
        sessionId: agentMeta.sessionId || null,
        provider: agentMeta.provider || null,
        model: agentMeta.model || null,
        usage: agentMeta.usage || null,
      };
    } catch {
      parsedMeta = null;
    }
    return {
      reply: parsedReply.trim(),
      meta: parsedMeta,
      rawPreview: trimText(rawJson.trim(), 1600),
    };
  }
  return {
    text: trimText(stdout.trim(), 1600),
  };
}

function mergeEvents(logEvents, actionEvents, limit) {
  return [...logEvents, ...actionEvents]
    .filter(Boolean)
    .sort((a, b) => parseTs(a.ts) - parseTs(b.ts))
    .slice(-limit)
    .reverse();
}

function deriveIncident(events) {
  const ordered = [...events].sort((a, b) => parseTs(a.ts) - parseTs(b.ts));
  let current = null;
  let lastResolved = null;
  for (const event of ordered) {
    if (["gateway_down_detected", "gateway_health_failed", "gateway_offline"].includes(event.type)) {
      current = {
        hasRecentIncident: true,
        detectedAt: event.ts,
        reason: event.message,
        recoveryAction: null,
        resolvedAt: null,
        outcome: "ongoing",
      };
    }
    if (!current) {
      continue;
    }
    if (["restart_attempted", "restart_requested"].includes(event.type)) {
      current.recoveryAction = event.message;
    }
    if (event.type === "gateway_online") {
      current.resolvedAt = event.ts;
      current.outcome = "recovered";
      if (!current.recoveryAction) {
        current.recoveryAction = "Gateway returned to online status.";
      }
      lastResolved = current;
      current = null;
      continue;
    }
    if (event.type === "restart_succeeded") {
      current.resolvedAt = event.ts;
      current.outcome = "recovered";
      lastResolved = current;
      current = null;
      continue;
    }
    if (["restart_failed", "cooldown_entered"].includes(event.type)) {
      current.resolvedAt = event.ts;
      current.outcome = "failed";
      lastResolved = current;
      current = null;
    }
  }
  return (
    current ||
    lastResolved || {
      hasRecentIncident: false,
      detectedAt: null,
      reason: null,
      recoveryAction: null,
      resolvedAt: null,
      outcome: null,
    }
  );
}

function readTailResult(lines, source) {
  return {
    source,
    lines: lines.map((line, index) => ({
      id: `${source}_${index}`,
      text: line,
      ts: extractTimestamp(line),
    })),
  };
}

async function buildStatusModel() {
  const [services, watchdogState, gatewayListening, gatewayHealth, backups] = await Promise.all([
    getServiceMap(),
    readStateEnv(),
    isPortListening(config.gatewayPort),
    getGatewayHealth(),
    getBackups(),
  ]);

  const gatewayService = normalizeService(services.get(config.gatewayLabel));
  const watchdogService = normalizeService(services.get(config.watchdogLabel));
  const watchdogStateLoopTs = parseTs(watchdogState.WATCHDOG_LAST_LOOP_AT);
  const watchdogStateIsFresh = watchdogStateLoopTs > 0 && Date.now() - watchdogStateLoopTs <= WATCHDOG_STATE_STALE_MS;

  let recoveryStateRaw = watchdogState.WATCHDOG_STATUS || (watchdogService.status === "running" ? "idle" : "unknown");
  if (watchdogService.status === "running") {
    if (!watchdogStateIsFresh || recoveryStateRaw === "stopped") {
      recoveryStateRaw = "idle";
    }
  } else {
    recoveryStateRaw = "stopped";
  }

  const gatewayStatus = gatewayService.status === "running" && gatewayListening ? "online" : "offline";
  const gateway = {
    status: gatewayStatus,
    pid: gatewayService.pid,
    port: config.gatewayPort,
    health: gatewayHealth.ok ? "ok" : gatewayStatus === "online" ? "fail" : "unknown",
    lastHealthCheckAt: watchdogState.WATCHDOG_LAST_HEALTH_CHECK_AT || null,
  };
  const watchdog = {
    status: watchdogService.status === "running" ? "running" : "stopped",
    pid: watchdogService.pid,
    lock: watchdogService.status === "running" ? "held" : "unknown",
    lastLoopAt: watchdogStateIsFresh ? watchdogState.WATCHDOG_LAST_LOOP_AT || null : null,
    lastHealthResult: watchdogStateIsFresh ? watchdogState.WATCHDOG_LAST_HEALTH_RESULT || "unknown" : "unknown",
  };
  const recovery = {
    state: ["recovering", "cooldown", "idle", "degraded", "starting", "stopped"].includes(recoveryStateRaw)
      ? recoveryStateRaw === "starting"
        ? "recovering"
        : recoveryStateRaw
      : "unknown",
    restartCountWindow: Number(watchdogState.WATCHDOG_RESTART_COUNT_WINDOW || 0),
    cooldownUntil: watchdogState.WATCHDOG_COOLDOWN_UNTIL || null,
    lastRecoveryMode: watchdogState.WATCHDOG_LAST_RECOVERY_MODE || null,
    lastRecoveryAt: watchdogState.WATCHDOG_LAST_RECOVERY_AT || null,
    lastErrorCode: watchdogState.WATCHDOG_LAST_ERROR_CODE || null,
  };

  const events = await getEvents(30);
  const incident = deriveIncident(events);
  const overall = {
    ...buildOverallStatus({ gateway, watchdog, recovery }),
    updatedAt: nowIso(),
  };
  const actionability = {
    canRestartGateway: true,
    canRunPostbootCheck: true,
    canCreateBackup: true,
    canTestChat: gateway.status === "online",
    canRollback: backups.items.length > 0,
    reasonIfBlocked: gateway.status === "online" ? null : "Gateway is currently offline",
  };

  return {
    overall,
    gateway,
    watchdog,
    recovery,
    incident,
    actionability,
  };
}

async function getStatusModel(force = false) {
  const now = Date.now();
  if (!force && statusCache.value && statusCache.expiresAt > now) {
    return statusCache.value;
  }
  const value = await buildStatusModel();
  statusCache = {
    value,
    expiresAt: now + STATUS_CACHE_TTL_MS,
  };
  return value;
}

function invalidateStatusCache() {
  statusCache = {
    value: null,
    expiresAt: 0,
  };
}

async function getEvents(limit = 30) {
  const [watchdogLines, actionEvents] = await Promise.all([
    tailLines(config.watchdogLog, 400),
    readConsoleEvents(100),
  ]);
  const parsed = watchdogLines.map(parseWatchdogLogLine).filter(Boolean);
  return mergeEvents(parsed, actionEvents, limit);
}

async function getBackups() {
  const items = [];
  const entries = await readdir(config.backupsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dirPath = path.join(config.backupsDir, entry.name);
    const metaText = await readFile(path.join(dirPath, "meta.txt"), "utf8").catch(() => "");
    const meta = parseEnv(metaText);
    const [projectStat, launchStat] = await Promise.all([
      stat(path.join(dirPath, "project.tar.gz")).catch(() => null),
      stat(path.join(dirPath, "launchagents.tar.gz")).catch(() => null),
    ]);
    items.push({
      id: entry.name,
      createdAt: meta.created_at || null,
      label: meta.snapshot_id ? `Snapshot ${meta.snapshot_id}` : `Snapshot ${entry.name}`,
      size: (projectStat?.size || 0) + (launchStat?.size || 0),
      source: "operator",
    });
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id))).reverse();
  return { items };
}

async function getMeta() {
  return {
    appName: "OpenClaw Console",
    consoleVersion: "v1",
    alertEnabled: Boolean(config.rawEnv.OPENCLAW_ALERT_WEBHOOK_URL) ||
      Boolean(config.rawEnv.OPENCLAW_ALERT_TELEGRAM_BOT_TOKEN && config.rawEnv.OPENCLAW_ALERT_TELEGRAM_CHAT_ID),
    tokenConfigured: Boolean(config.gatewayToken),
    tokenFingerprint: config.gatewayToken ? `${config.gatewayToken.slice(0, 6)}...${config.gatewayToken.slice(-4)}` : null,
    agentId: config.agentId,
    gatewayPort: config.gatewayPort,
    consolePort: config.consolePort,
    consoleUrl: `http://${config.host}:${config.consolePort}`,
    gatewayLabel: config.gatewayLabel,
    watchdogLabel: config.watchdogLabel,
    consoleLabel: config.consoleLabel,
  };
}

async function getLogs(source = "gateway", limit = 200) {
  const maxLimit = Math.min(Number(limit || 200), 400);
  if (source === "gateway") {
    const lines = await tailLines(config.gatewayLog, maxLimit);
    return readTailResult(lines, source);
  }
  if (source === "watchdog") {
    const lines = await tailLines(config.watchdogLog, maxLimit);
    return readTailResult(lines, source);
  }
  if (source === "error") {
    const [watchdogErr, gatewayErr] = await Promise.all([
      tailLines(config.watchdogErrLog, Math.ceil(maxLimit / 2)),
      tailLines(config.gatewayErrLog, Math.ceil(maxLimit / 2)),
    ]);
    const lines = [...watchdogErr, ...gatewayErr].slice(-maxLimit);
    return readTailResult(lines, source);
  }

  return {
    source,
    lines: [],
    error: {
      code: "INVALID_SOURCE",
      message: "Unsupported log source",
      details: { source },
    },
  };
}

async function executeAction(action, body) {
  const actionId = `act_${crypto.randomBytes(6).toString("hex")}`;
  const startedAt = nowIso();
  let result;
  let summary = "";
  let status = "completed";
  let event = null;

  if (action === "restart-gateway") {
    const primary = await runOpenclaw(["gateway", "restart"], { timeoutMs: 45000 });
    result = primary;
    if (!primary.ok) {
      const uid = String(process.getuid());
      const fallbackStop = await runOpenclaw(["gateway", "stop"], { timeoutMs: 15000 });
      const fallbackBootout = await runCommand("/bin/launchctl", ["bootout", `gui/${uid}/${config.gatewayLabel}`], {
        timeoutMs: 12000,
      });
      const fallbackStart = await runOpenclaw(["gateway", "start"], { timeoutMs: 45000 });
      const fallbackEnable = await runCommand("/bin/launchctl", ["enable", `gui/${uid}/${config.gatewayLabel}`], {
        timeoutMs: 8000,
      });
      const fallbackKickstart = await runCommand("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${config.gatewayLabel}`], {
        timeoutMs: 12000,
      });
      const fallbackHealth = await runOpenclaw(["gateway", "health", "--timeout", "5000"], { timeoutMs: 10000 });
      const fallbackOk = fallbackHealth.ok && (fallbackStart.ok || fallbackKickstart.ok);
      result = {
        ok: fallbackOk,
        code: fallbackOk ? 0 : 1,
        stdout: [primary.stdout, fallbackStart.stdout, fallbackHealth.stdout].filter(Boolean).join("\n"),
        stderr: [primary.stderr, fallbackStart.stderr, fallbackKickstart.stderr, fallbackHealth.stderr]
          .filter(Boolean)
          .join("\n"),
        message: fallbackOk ? "Gateway recovered by fallback restart path" : primary.message || "Gateway restart failed",
      };
      result.fallback = {
        fallbackStop,
        fallbackBootout,
        fallbackStart,
        fallbackEnable,
        fallbackKickstart,
        fallbackHealth,
      };
    }

    summary = result.ok ? "Gateway restart completed." : "Gateway restart failed.";
    event = buildEvent({
      ts: nowIso(),
      level: result.ok ? "success" : "error",
      source: "operator",
      category: "recovery",
      type: result.ok ? "restart_requested" : "restart_failed",
      title: result.ok ? "Gateway Restart Requested" : "Gateway Restart Failed",
      message: result.ok
        ? "Operator requested a manual gateway restart."
        : result.stderr || result.stdout || "Gateway restart failed.",
      actionId,
    });
  } else if (action === "postboot-check") {
    result = await runCtl(["postboot-check", String(body.timeoutSeconds || 45)], { timeoutMs: 90000, maxBuffer: 1024 * 1024 * 4 });
    summary = result.ok ? "Postboot check passed." : "Postboot check failed.";
  } else if (action === "create-backup") {
    result = await runCtl(["backup"], { timeoutMs: 30000 });
    summary = result.ok ? "Backup snapshot created." : "Backup snapshot failed.";
    event = buildEvent({
      ts: nowIso(),
      level: result.ok ? "success" : "error",
      source: "operator",
      category: "backup",
      type: result.ok ? "backup_created" : "backup_failed",
      title: result.ok ? "Backup Created" : "Backup Failed",
      message: result.ok ? "Operator created a new backup snapshot." : result.stderr || result.stdout || "Backup snapshot failed.",
      actionId,
    });
  } else if (action === "test-chat") {
    const message = String(body.message || "watchdog online?");
    result = await runChat(message);
    const parsed = parseActionOutput(action, result.stdout);
    summary = result.ok ? `Test chat completed: ${parsed.reply || "reply received"}` : "Test chat failed.";
    result.parsed = parsed;
    event = buildEvent({
      ts: nowIso(),
      level: result.ok ? "success" : "error",
      source: "operator",
      category: "chat",
      type: result.ok ? "chat_test_completed" : "chat_test_failed",
      title: result.ok ? "Test Chat Completed" : "Test Chat Failed",
      message: result.ok ? parsed.reply || "Test chat completed." : result.stderr || result.stdout || "Test chat failed.",
      actionId,
    });
  } else if (action === "rollback") {
    const snapshotId = String(body.snapshotId || "");
    if (!snapshotId) {
      return {
        ok: false,
        status: "blocked",
        actionId,
        startedAt,
        finishedAt: nowIso(),
        summary: "Rollback blocked.",
        error: {
          code: "ACTION_BLOCKED",
          message: "snapshotId is required",
          details: {},
        },
      };
    }
    result = await runCtl(["rollback", snapshotId], { timeoutMs: 120000, maxBuffer: 1024 * 1024 * 4 });
    summary = result.ok ? `Rollback to ${snapshotId} completed.` : `Rollback to ${snapshotId} failed.`;
    event = buildEvent({
      ts: nowIso(),
      level: result.ok ? "success" : "error",
      source: "operator",
      category: "backup",
      type: result.ok ? "rollback_completed" : "rollback_failed",
      title: result.ok ? "Rollback Completed" : "Rollback Failed",
      message: summary,
      actionId,
    });
  } else {
    return {
      ok: false,
      status: "blocked",
      actionId,
      startedAt,
      finishedAt: nowIso(),
      summary: "Action blocked.",
      error: {
        code: "ACTION_BLOCKED",
        message: "Unsupported action",
        details: { action },
      },
    };
  }

  if (!result.ok) {
    status = "failed";
  }

  if (event) {
    await appendConsoleEvent(event);
  }
  invalidateStatusCache();

  return {
    ok: result.ok,
    actionId,
    action,
    status,
    startedAt,
    finishedAt: nowIso(),
    summary,
    result: {
      stdout: trimText(result.stdout || "", 1600),
      stderr: trimText(result.stderr || "", 1600),
      parsed: result.parsed || null,
    },
    error: result.ok
      ? null
      : {
          code: "ACTION_FAILED",
          message: result.stderr || result.stdout || result.message || "Action failed",
          details: { action },
        },
  };
}

export {
  config,
  nowIso,
  parseTs,
  loadConfig,
  ensureRuntime,
  readStateEnv,
  tailLines,
  getStatusModel,
  invalidateStatusCache,
  getEvents,
  getBackups,
  getMeta,
  getLogs,
  executeAction,
};
