import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  gatewayInstall,
  gatewayRestart,
  gatewayStart,
  gatewayStop,
  getGatewayStatus,
  getGitInfo,
  getLogs,
  healthCheck,
  probeGateway,
  runDoctor,
  validateTarget,
} from "../adapter/openclaw/index.mjs";
import {
  AUTO_RECOVERY_COOLDOWN_MS,
  POLL_INTERVAL_MS,
  REPAIR_ACTIONS,
  SUPERVISOR_LABEL,
} from "../shared/constants.mjs";
import {
  appendJsonLine,
  clearSocketIfStale,
  createId,
  ensureRuntimeDirs,
  getRuntimePaths,
  logLine,
  nowIso,
  readJson,
  readJsonLines,
  readTextTail,
  rotateLogFile,
  sanitizeFileName,
  summarizeError,
  writeJson,
} from "../shared/runtime.mjs";
import { ensureSupervisorInstalled } from "./install.mjs";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const runtimePaths = await ensureRuntimeDirs();

let config = await loadConfig();
let currentStatus = await readJson(runtimePaths.statusPath, buildMissingStatus());
let refreshPromise = null;
let actionLocked = false;
let monitorTimer = null;
let server = null;
let recoveryState = {
  active: false,
  lastAttemptAt: 0,
  lastSignature: null,
  lastAction: null,
  lastResult: null,
};

function buildDefaultConfig() {
  return {
    version: 1,
    target: {
      repoRoot: "",
      resolvedCliPath: "",
      resolvedConfigPath: "",
      gatewayPort: null,
      gatewayLabel: "ai.openclaw.gateway",
      autoRecoveryEnabled: false,
      supervisorEnabled: true,
      secretRef: null,
      nodePath: "",
      lastValidatedAt: null,
    },
    updatedAt: nowIso(),
  };
}

function buildMissingStatus() {
  return {
    ts: nowIso(),
    overall: "offline",
    target: "missing",
    install: { cliFound: false, repoValid: false, version: null },
    service: { loaded: false, pid: null, state: "inactive" },
    port: { listening: false, listeners: [], port: null },
    health: { state: "stale", ok: false, lastCheckedAt: null, output: "No target attached" },
    recovery: {
      enabled: false,
      state: "disabled",
      lastAction: null,
      lastAt: null,
      lastResult: null,
    },
    git: {
      available: false,
      branch: null,
      dirty: false,
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      recentCommit: null,
      recentCommits: [],
    },
    incident: {
      lastReason: null,
      lastAction: null,
      lastAt: null,
      lastResult: null,
      successRate: null,
      repeatedSignature: false,
    },
    targetInfo: { repoRoot: null, configPath: null, gatewayPort: null, gatewayLabel: null },
    diagnostics: { errors: [], warnings: [] },
  };
}

async function loadConfig() {
  return (await readJson(runtimePaths.configPath, buildDefaultConfig())) || buildDefaultConfig();
}

async function saveConfig(nextConfig) {
  config = {
    ...buildDefaultConfig(),
    ...nextConfig,
    target: {
      ...buildDefaultConfig().target,
      ...(nextConfig?.target || {}),
    },
    updatedAt: nowIso(),
  };
  await writeJson(runtimePaths.configPath, config);
  return config;
}

async function supervisorLog(level, message, details = "") {
  await rotateLogFile(runtimePaths.supervisorLogPath);
  await logLine(runtimePaths.supervisorLogPath, `[supervisor][${level}] ${message}${details ? ` | ${details}` : ""}`);
}

function hasTarget() {
  return Boolean(config?.target?.repoRoot);
}

function targetDescriptor() {
  return {
    repoRoot: config.target.repoRoot,
    resolvedCliPath: config.target.resolvedCliPath,
    resolvedConfigPath: config.target.resolvedConfigPath,
    gatewayPort: config.target.gatewayPort,
    gatewayLabel: config.target.gatewayLabel || "ai.openclaw.gateway",
    nodePath: config.target.nodePath,
  };
}

function activeProbeTarget(probeData) {
  const targets = probeData?.targets || [];
  return targets.find((entry) => entry.active) || targets[0] || null;
}

async function getIncidentSummary() {
  const history = await readJsonLines(runtimePaths.incidentsPath, 30);
  const latest = history[0] || null;
  const recoveryItems = history.filter((entry) => entry.repairAction);
  const recovered = recoveryItems.filter((entry) => entry.result === "recovered").length;
  const successRate = recoveryItems.length ? Math.round((recovered / recoveryItems.length) * 100) : null;
  const repeatedSignature = Boolean(
    latest?.crashSignature && history.slice(1).some((entry) => entry.crashSignature === latest.crashSignature),
  );

  return {
    summary: {
      lastReason: latest?.trigger || null,
      lastAction: latest?.repairAction || null,
      lastAt: latest?.ts || null,
      lastResult: latest?.result || null,
      successRate,
      repeatedSignature,
    },
    history,
  };
}

function deriveOverall({ targetState, serviceLoaded, portListening, healthOk, healthState }) {
  if (targetState !== "attached") {
    return "offline";
  }
  if (serviceLoaded && portListening && healthOk) {
    return "healthy";
  }
  if (!serviceLoaded && !portListening && healthState !== "ok") {
    return "offline";
  }
  return "degraded";
}

function crashSignatureFromStatus(status) {
  return [
    status.target,
    status.service.state || "unknown",
    status.port.listening ? "port_up" : "port_down",
    status.health.state || "unknown",
  ].join(":");
}

function sanitizeSnapshot(status) {
  return {
    overall: status.overall,
    target: status.target,
    service: status.service,
    port: status.port,
    health: status.health,
    git: {
      branch: status.git.branch,
      dirty: status.git.dirty,
      dirtyCount: status.git.dirtyCount,
      ahead: status.git.ahead,
      behind: status.git.behind,
      recentCommit: status.git.recentCommit,
    },
  };
}

async function recordIncident(payload) {
  const entry = {
    id: createId("inc"),
    ts: nowIso(),
    repoRoot: config.target.repoRoot || null,
    trigger: payload.trigger,
    probeSnapshot: payload.probeSnapshot || sanitizeSnapshot(currentStatus),
    doctorSummary: payload.doctorSummary || [],
    repairAction: payload.repairAction || null,
    durationMs: payload.durationMs ?? null,
    result: payload.result || "unknown",
    crashSignature: payload.crashSignature || crashSignatureFromStatus(currentStatus),
  };
  await appendJsonLine(runtimePaths.incidentsPath, entry);
  return entry;
}

async function probeStatus() {
  if (!hasTarget()) {
    return buildMissingStatus();
  }

  const validation = await validateTarget(config.target.repoRoot);
  if (!validation.ok) {
    return {
      ...buildMissingStatus(),
      ts: nowIso(),
      target: "invalid",
      install: { cliFound: Boolean(validation.resolvedCliPath), repoValid: false, version: validation.version },
      diagnostics: { errors: [validation.error], warnings: [] },
      targetInfo: {
        repoRoot: config.target.repoRoot,
        configPath: validation.resolvedConfigPath,
        gatewayPort: config.target.gatewayPort,
        gatewayLabel: config.target.gatewayLabel || "ai.openclaw.gateway",
      },
      git: validation.git,
      recovery: {
        enabled: Boolean(config.target.autoRecoveryEnabled),
        state: config.target.autoRecoveryEnabled ? "idle" : "disabled",
        lastAction: recoveryState.lastAction,
        lastAt: recoveryState.lastAttemptAt ? new Date(recoveryState.lastAttemptAt).toISOString() : null,
        lastResult: recoveryState.lastResult,
      },
    };
  }

  const target = {
    ...validation,
    repoRoot: config.target.repoRoot,
  };

  const [statusResult, probeResult, healthResult, gitInfo, incidentInfo] = await Promise.all([
    getGatewayStatus(target),
    probeGateway(target),
    healthCheck(target),
    getGitInfo(target.repoRoot),
    getIncidentSummary(),
  ]);

  const statusData = statusResult.ok ? statusResult.data : null;
  const probeTarget = probeResult.ok ? activeProbeTarget(probeResult.data) : null;
  const serviceRuntime = statusData?.service?.runtime || {};
  const serviceCommand = statusData?.service?.command || {};
  const launchdLabel =
    serviceCommand?.environment?.OPENCLAW_LAUNCHD_LABEL || config.target.gatewayLabel || validation.gatewayLabel;
  const port =
    statusData?.gateway?.port ||
    probeTarget?.config?.gateway?.port ||
    config.target.gatewayPort ||
    null;
  const serviceLoaded = Boolean(statusData?.service?.loaded && serviceRuntime?.pid);
  const portListening = Boolean((statusData?.port?.listeners || []).length);
  const lastCheckedAt = nowIso();
  const healthOk = Boolean(healthResult.ok && probeTarget?.health?.ok !== false);
  const healthState = healthOk
    ? "ok"
    : serviceLoaded || portListening
      ? "fail"
      : "stale";
  const diagnostics = {
    errors: [statusResult, probeResult]
      .filter((item) => !item.ok)
      .map((item) => item.error)
      .filter(Boolean),
    warnings: [],
  };

  const status = {
    ts: lastCheckedAt,
    overall: deriveOverall({
      targetState: "attached",
      serviceLoaded,
      portListening,
      healthOk,
      healthState,
    }),
    target: "attached",
    install: {
      cliFound: true,
      repoValid: true,
      version: validation.version,
    },
    service: {
      loaded: Boolean(statusData?.service?.loaded),
      pid: serviceRuntime?.pid || null,
      state: serviceRuntime?.state || serviceRuntime?.status || (serviceLoaded ? "active" : "inactive"),
      runtimeStatus: serviceRuntime?.status || null,
    },
    port: {
      listening: portListening,
      listeners: statusData?.port?.listeners || [],
      port,
      status: statusData?.port?.status || null,
    },
    health: {
      state: healthState,
      ok: healthOk,
      lastCheckedAt,
      output: healthResult.output || probeTarget?.health?.error || statusResult.error || probeResult.error || "",
      durationMs: probeTarget?.health?.durationMs || null,
    },
    recovery: {
      enabled: Boolean(config.target.autoRecoveryEnabled),
      state: recoveryState.active ? "recovering" : config.target.autoRecoveryEnabled ? "idle" : "disabled",
      lastAction: recoveryState.lastAction,
      lastAt: recoveryState.lastAttemptAt ? new Date(recoveryState.lastAttemptAt).toISOString() : null,
      lastResult: recoveryState.lastResult,
    },
    git: gitInfo,
    incident: incidentInfo.summary,
    targetInfo: {
      repoRoot: target.repoRoot,
      configPath:
        statusData?.config?.cli?.path || probeTarget?.config?.path || validation.resolvedConfigPath || config.target.resolvedConfigPath,
      gatewayPort: port,
      gatewayLabel: launchdLabel,
      bindMode: statusData?.gateway?.bindMode || probeTarget?.config?.gateway?.bind || null,
      probeUrl: statusData?.gateway?.probeUrl || probeTarget?.url || null,
      model: probeTarget?.health?.defaultAgentId || null,
    },
    diagnostics,
  };

  const nextConfig = {
    ...config,
    target: {
      ...config.target,
      resolvedCliPath: validation.resolvedCliPath,
      resolvedConfigPath: status.targetInfo.configPath,
      gatewayPort: port,
      gatewayLabel: launchdLabel,
      nodePath: validation.nodePath,
      lastValidatedAt: nowIso(),
    },
  };
  await saveConfig(nextConfig);
  return status;
}

async function persistStatus(status) {
  currentStatus = status;
  await writeJson(runtimePaths.statusPath, status);
  return currentStatus;
}

async function refreshWithoutRecovery() {
  const status = await probeStatus();
  return persistStatus(status);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRecoveryAction(action, reason) {
  const target = targetDescriptor();
  const startedAt = Date.now();
  let primaryResult = null;
  let finalStatus = currentStatus;

  if (action === "restart_gateway") {
    primaryResult = await gatewayRestart(target);
    await sleep(1500);
    finalStatus = await refreshWithoutRecovery();
  } else if (action === "reinstall_gateway_launchd") {
    primaryResult = await gatewayInstall(target);
    await sleep(1000);
    await gatewayStart(target);
    await sleep(1500);
    finalStatus = await refreshWithoutRecovery();
  } else if (action === "restart_supervisor") {
    setTimeout(() => {
      execFile("/bin/sh", ["-lc", `sleep 1; launchctl kickstart -k gui/${process.getuid?.() || process.env.UID || 501}/${SUPERVISOR_LABEL}`], {
        detached: true,
        stdio: "ignore",
      });
    }, 50);
    primaryResult = { ok: true, stdout: "restart scheduled" };
  } else if (action === "reinstall_supervisor_launchd") {
    await ensureSupervisorInstalled({ agentPath: __filename, nodePath: config.target.nodePath });
    primaryResult = { ok: true, stdout: "supervisor launchd reinstalled" };
  } else {
    throw new Error(`Unsupported repair action: ${action}`);
  }

  const durationMs = Date.now() - startedAt;
  recoveryState.lastAttemptAt = Date.now();
  recoveryState.lastSignature = crashSignatureFromStatus(currentStatus);
  recoveryState.lastAction = action;
  recoveryState.lastResult = finalStatus.overall === "healthy" ? "recovered" : primaryResult?.ok ? "partial" : "failed";

  await recordIncident({
    trigger: reason,
    repairAction: action,
    durationMs,
    result: recoveryState.lastResult,
    crashSignature: crashSignatureFromStatus(currentStatus),
  });

  return {
    ok: Boolean(primaryResult?.ok),
    action,
    durationMs,
    stdout: primaryResult?.stdout || "",
    stderr: primaryResult?.stderr || primaryResult?.message || "",
    status: finalStatus,
  };
}

async function performManualRepair() {
  const restart = await runRecoveryAction("restart_gateway", "manual_repair_restart");
  if (restart.status?.overall === "healthy") {
    return {
      ok: true,
      summary: "Gateway restart recovered the runtime",
      steps: [restart],
      status: restart.status,
    };
  }

  const reinstall = await runRecoveryAction("reinstall_gateway_launchd", "manual_repair_reinstall");
  return {
    ok: reinstall.status?.overall === "healthy",
    summary:
      reinstall.status?.overall === "healthy"
        ? "Gateway launchd reinstall recovered the runtime"
        : "Gateway remains degraded after process and launchd repair",
    steps: [restart, reinstall],
    status: reinstall.status,
  };
}

async function maybeAutoRecover(status) {
  if (!config.target.autoRecoveryEnabled || recoveryState.active || status.overall === "healthy") {
    return status;
  }

  const signature = crashSignatureFromStatus(status);
  const now = Date.now();
  if (
    recoveryState.lastSignature === signature &&
    now - recoveryState.lastAttemptAt < AUTO_RECOVERY_COOLDOWN_MS
  ) {
    return status;
  }

  recoveryState.active = true;
  await persistStatus({
    ...status,
    recovery: {
      ...status.recovery,
      state: "recovering",
      enabled: true,
      lastAction: recoveryState.lastAction,
      lastAt: recoveryState.lastAttemptAt ? new Date(recoveryState.lastAttemptAt).toISOString() : null,
      lastResult: recoveryState.lastResult,
    },
  });
  await supervisorLog("warn", "Auto recovery triggered", signature);

  try {
    const result = await runRecoveryAction("restart_gateway", "auto_recovery");
    return result.status || status;
  } finally {
    recoveryState.active = false;
  }
}

async function refreshStatus(reason = "manual", options = {}) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const status = await probeStatus();
      const persisted = await persistStatus(status);
      if (options.allowRecovery === false) {
        return persisted;
      }
      return maybeAutoRecover(persisted);
    } catch (error) {
      const fallback = {
        ...currentStatus,
        ts: nowIso(),
        overall: currentStatus.target === "attached" ? "degraded" : "offline",
        diagnostics: {
          ...(currentStatus.diagnostics || { warnings: [], errors: [] }),
          errors: [...(currentStatus.diagnostics?.errors || []), `[${reason}] ${summarizeError(error)}`],
        },
      };
      await persistStatus(fallback);
      await supervisorLog("error", "refreshStatus failed", summarizeError(error));
      return fallback;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function handleAttachTarget(params) {
  const validation = await validateTarget(params.repoRoot);
  if (!validation.ok) {
    throw new Error(validation.error || "Target validation failed");
  }

  await saveConfig({
    ...config,
    target: {
      ...config.target,
      repoRoot: validation.repoRoot,
      resolvedCliPath: validation.resolvedCliPath,
      resolvedConfigPath: validation.resolvedConfigPath,
      gatewayPort: validation.gatewayPort,
      gatewayLabel: validation.gatewayLabel,
      autoRecoveryEnabled: Boolean(config.target.autoRecoveryEnabled),
      supervisorEnabled: true,
      secretRef: null,
      nodePath: validation.nodePath,
      lastValidatedAt: nowIso(),
    },
  });

  const status = await refreshStatus("attach_target");
  await recordIncident({
    trigger: "attach_target",
    repairAction: null,
    durationMs: 0,
    result: status.overall,
    crashSignature: crashSignatureFromStatus(status),
  });
  return { config, status };
}

async function handleSetAutoRecovery(params) {
  await saveConfig({
    ...config,
    target: {
      ...config.target,
      autoRecoveryEnabled: Boolean(params.enabled),
    },
  });
  const status = await refreshStatus("toggle_auto_recovery", { allowRecovery: false });
  return { enabled: config.target.autoRecoveryEnabled, status };
}

async function handleAction(params) {
  if (actionLocked) {
    throw new Error("Another action is already running");
  }
  actionLocked = true;
  try {
    const target = targetDescriptor();
    switch (params.name) {
      case "start": {
        const result = await gatewayStart(target);
        const status = await refreshStatus("manual_start", { allowRecovery: false });
        await recordIncident({ trigger: "manual_start", repairAction: null, durationMs: null, result: result.ok ? "completed" : "failed" });
        return { ok: result.ok, stdout: result.stdout, stderr: result.stderr || result.message || "", status };
      }
      case "stop": {
        const result = await gatewayStop(target);
        const status = await refreshStatus("manual_stop", { allowRecovery: false });
        await recordIncident({ trigger: "manual_stop", repairAction: null, durationMs: null, result: result.ok ? "completed" : "failed" });
        return { ok: result.ok, stdout: result.stdout, stderr: result.stderr || result.message || "", status };
      }
      case "restart": {
        const result = await runRecoveryAction("restart_gateway", "manual_restart");
        return {
          ok: result.ok,
          stdout: result.stdout,
          stderr: result.stderr,
          status: result.status,
        };
      }
      case "doctor": {
        const result = await runDoctor(target);
        await recordIncident({
          trigger: "manual_doctor",
          doctorSummary: result.summary,
          result: result.ok ? "completed" : "failed",
          crashSignature: crashSignatureFromStatus(currentStatus),
        });
        return result;
      }
      case "repair": {
        return performManualRepair();
      }
      case "exportDiagnostics": {
        return exportDiagnostics();
      }
      case "restart_supervisor": {
        return runRecoveryAction("restart_supervisor", "manual_restart_supervisor");
      }
      case "reinstall_supervisor_launchd": {
        return runRecoveryAction("reinstall_supervisor_launchd", "manual_reinstall_supervisor");
      }
      default:
        throw new Error(`Unsupported action: ${params.name}`);
    }
  } finally {
    actionLocked = false;
  }
}

async function exportDiagnostics() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const folderName = `diagnostic-${stamp}`;
  const folderPath = path.join(runtimePaths.exportsDir, folderName);
  await mkdir(folderPath, { recursive: true });

  const [status, history, doctor, gatewayLogs, supervisorLogs] = await Promise.all([
    refreshStatus("export_diagnostics", { allowRecovery: false }),
    getIncidentSummary(),
    runDoctor(targetDescriptor()),
    getLogs(targetDescriptor(), { source: "gateway", limit: 200 }),
    readTextTail(runtimePaths.supervisorLogPath),
  ]);

  await writeJson(path.join(folderPath, "status.json"), status);
  await writeJson(path.join(folderPath, "config.json"), {
    target: {
      repoRoot: config.target.repoRoot,
      resolvedCliPath: config.target.resolvedCliPath,
      resolvedConfigPath: config.target.resolvedConfigPath,
      gatewayPort: config.target.gatewayPort,
      gatewayLabel: config.target.gatewayLabel,
      autoRecoveryEnabled: config.target.autoRecoveryEnabled,
      supervisorEnabled: config.target.supervisorEnabled,
      secretRef: config.target.secretRef,
      lastValidatedAt: config.target.lastValidatedAt,
    },
  });
  await writeJson(path.join(folderPath, "incident-history.json"), history);
  await writeJson(path.join(folderPath, "git.json"), status.git);
  await writeJson(path.join(folderPath, "gateway-logs.json"), gatewayLogs);
  await writeJson(path.join(folderPath, "doctor-summary.json"), {
    ok: doctor.ok,
    summary: doctor.summary,
    error: doctor.error,
  });
  await writeJson(path.join(folderPath, "metadata.json"), {
    exportedAt: nowIso(),
    host: os.hostname(),
    app: SUPERVISOR_LABEL,
  });
  await writeJson(path.join(folderPath, "last-incident.json"), status.incident);
  await writeJson(path.join(folderPath, "repair-actions.json"), REPAIR_ACTIONS);

  await writeJson(path.join(folderPath, "supervisor-log.json"), {
    text: supervisorLogs,
  });

  const zipPath = `${folderPath}.zip`;
  try {
    await execFileAsync("/usr/bin/zip", ["-qr", zipPath, folderName], {
      cwd: runtimePaths.exportsDir,
      timeout: 20000,
      maxBuffer: 10 * 1024 * 1024,
    });
    await recordIncident({ trigger: "export_diagnostics", result: "completed" });
    return { ok: true, folderPath, zipPath };
  } catch {
    await recordIncident({ trigger: "export_diagnostics", result: "partial" });
    return { ok: true, folderPath, zipPath: null };
  }
}

async function getHistoryPayload() {
  const { summary, history } = await getIncidentSummary();
  return { summary, items: history };
}

async function handleRequest(payload) {
  switch (payload.method) {
    case "ping":
      return { ok: true, ts: nowIso(), label: SUPERVISOR_LABEL };
    case "getStatus": {
      const status = await refreshStatus("rpc_status");
      return { status };
    }
    case "getHistory": {
      return getHistoryPayload();
    }
    case "getLogs": {
      return getLogs(targetDescriptor(), payload.params || {});
    }
    case "attachTarget": {
      return handleAttachTarget(payload.params || {});
    }
    case "setAutoRecovery": {
      return handleSetAutoRecovery(payload.params || {});
    }
    case "runAction": {
      return handleAction(payload.params || {});
    }
    default:
      throw new Error(`Unknown supervisor method: ${payload.method}`);
  }
}

async function handleSocket(socket) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", async (chunk) => {
    buffer += chunk;
    const index = buffer.indexOf("\n");
    if (index === -1) {
      return;
    }

    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    try {
      const payload = JSON.parse(line);
      const data = await handleRequest(payload);
      socket.write(`${JSON.stringify({ ok: true, data })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({ ok: false, error: summarizeError(error) })}\n`);
      await supervisorLog("error", "RPC request failed", summarizeError(error));
    } finally {
      socket.end();
    }
  });
}

async function startServer() {
  await clearSocketIfStale(runtimePaths.socketPath);
  server = net.createServer((socket) => {
    handleSocket(socket).catch(() => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtimePaths.socketPath, () => resolve());
  });

  await supervisorLog("info", "Supervisor socket ready", runtimePaths.socketPath);
}

async function monitorLoop() {
  await refreshStatus("monitor_tick").catch(() => undefined);
}

function scheduleMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
  }
  monitorTimer = setInterval(() => {
    monitorLoop().catch(() => undefined);
  }, POLL_INTERVAL_MS);
  if (typeof monitorTimer.unref === "function") {
    monitorTimer.unref();
  }
}

async function boot() {
  await startServer();
  scheduleMonitor();
  await refreshStatus("boot", { allowRecovery: false });
  await supervisorLog("info", "Supervisor started", config.target.repoRoot || "no target");
}

process.on("uncaughtException", async (error) => {
  await supervisorLog("error", "uncaughtException", summarizeError(error));
});

process.on("unhandledRejection", async (error) => {
  await supervisorLog("error", "unhandledRejection", summarizeError(error));
});

process.on("SIGTERM", async () => {
  await supervisorLog("warn", "SIGTERM", "shutting down");
  if (monitorTimer) {
    clearInterval(monitorTimer);
  }
  if (server) {
    server.close();
  }
  await rm(runtimePaths.socketPath, { force: true }).catch(() => undefined);
  process.exit(0);
});

await boot();
