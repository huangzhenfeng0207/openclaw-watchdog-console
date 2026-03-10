import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, safeStorage } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEV_ROOT = path.resolve(__dirname, "..", "..");
const PACKAGED_ROOT = path.join(process.resourcesPath, "app-root");
const PROJECT_ROOT = app.isPackaged ? PACKAGED_ROOT : DEV_ROOT;
const UPDATE_URL = "https://github.com/huangzhenfeng0207/openclaw-watchdog-console/releases";

const APP_SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "OpenClaw");
const APP_LOG_DIR = path.join(os.homedir(), "Library", "Logs", "OpenClaw");
const DESKTOP_LOG_PATH = path.join(APP_LOG_DIR, "desktop.log");
const SECURE_STORE_PATH = path.join(APP_SUPPORT_DIR, "secure-store.json");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");

let mainWindow = null;
let tray = null;
let isQuitting = false;
let actionLock = false;
let core = null;
let bootstrapState = {
  tokenMissing: false,
  status: null,
  model: null,
  startupError: null,
};

function ts() {
  return new Date().toISOString();
}

async function rotateLogFile(filePath, maxBytes = 10 * 1024 * 1024, keep = 3) {
  let size = 0;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return;
  }
  if (size < maxBytes) {
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const rotated = `${filePath}.${stamp}`;
  await fs.promises.rename(filePath, rotated).catch(() => undefined);
  await appendFile(filePath, "").catch(() => undefined);

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const siblings = (await fs.promises.readdir(dir).catch(() => []))
    .filter((name) => name.startsWith(`${base}.`))
    .sort()
    .reverse();
  for (const extra of siblings.slice(keep)) {
    await fs.promises.rm(path.join(dir, extra), { force: true }).catch(() => undefined);
  }
}

async function log(level, message, details = "") {
  const line = `${ts()} [desktop][${level}] ${message}${details ? ` | ${details}` : ""}\n`;
  await rotateLogFile(DESKTOP_LOG_PATH);
  await appendFile(DESKTOP_LOG_PATH, line).catch(() => undefined);
}

async function ensureLocalDirs() {
  await mkdir(APP_SUPPORT_DIR, { recursive: true });
  await mkdir(APP_LOG_DIR, { recursive: true });
  await appendFile(DESKTOP_LOG_PATH, "").catch(() => undefined);
}

async function ensureExecutableScripts() {
  const scriptNames = ["install.sh", "ctl.sh", "watchdog.sh", "chat-with-openclaw.sh"];
  await Promise.all(
    scriptNames.map((name) =>
      fs.promises.chmod(path.join(PROJECT_ROOT, name), 0o755).catch(() => undefined),
    ),
  );
}

async function runCommand(file, args, timeoutMs = 30000) {
  try {
    const result = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
      cwd: PROJECT_ROOT,
    });
    return {
      ok: true,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || "").trim(),
      message: error.message || "command failed",
    };
  }
}

function parseEnvToken(text) {
  const match = text.match(/^OPENCLAW_GATEWAY_TOKEN=(.+)$/m);
  return match ? match[1].trim() : "";
}

async function readEnvToken() {
  const envText = await readFile(ENV_PATH, "utf8").catch(() => "");
  return parseEnvToken(envText);
}

async function maskEnvTokenLine() {
  const envText = await readFile(ENV_PATH, "utf8").catch(() => "");
  if (!envText.includes("OPENCLAW_GATEWAY_TOKEN=")) {
    return;
  }
  const replaced = envText.replace(
    /^OPENCLAW_GATEWAY_TOKEN=.*$/m,
    `# OPENCLAW_GATEWAY_TOKEN=*** migrated_to_secure_store ${ts()}`,
  );
  await writeFile(ENV_PATH, replaced, "utf8").catch(() => undefined);
}

async function loadSecureStore() {
  const raw = await readFile(SECURE_STORE_PATH, "utf8").catch(() => "");
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSecureStore(payload) {
  await writeFile(SECURE_STORE_PATH, JSON.stringify(payload, null, 2), "utf8");
}

function encryptString(value) {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      mode: "safeStorage",
      ciphertext: safeStorage.encryptString(value).toString("base64"),
    };
  }
  return {
    mode: "base64",
    ciphertext: Buffer.from(value, "utf8").toString("base64"),
  };
}

function decryptString(payload) {
  if (!payload?.ciphertext) {
    return "";
  }
  if (payload.mode === "safeStorage" && safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(Buffer.from(payload.ciphertext, "base64"));
  }
  return Buffer.from(payload.ciphertext, "base64").toString("utf8");
}

async function getStoredToken() {
  const store = await loadSecureStore();
  return decryptString(store.gatewayToken);
}

async function setStoredToken(token) {
  const store = await loadSecureStore();
  store.gatewayToken = {
    ...encryptString(token),
    updatedAt: ts(),
  };
  await saveSecureStore(store);
}

async function migrateTokenIfNeeded() {
  const secureToken = await getStoredToken();
  if (secureToken) {
    return { token: secureToken, migrated: false };
  }

  const envToken = await readEnvToken();
  if (!envToken) {
    return { token: "", migrated: false };
  }

  await setStoredToken(envToken);
  await maskEnvTokenLine();
  await log("info", "Gateway token migrated from .env to secure store");
  return { token: envToken, migrated: true };
}

async function importCore(token = "") {
  if (token) {
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
  }
  process.env.OPENCLAW_PROJECT_DIR = PROJECT_ROOT;

  const modulePath = pathToFileURL(path.join(PROJECT_ROOT, "console", "core", "api.mjs")).href;
  core = await import(modulePath);
  if (token) {
    core.config.gatewayToken = token;
  }
}

async function launchctlList() {
  const result = await runCommand("/bin/launchctl", ["list"], 10000);
  return result.ok ? result.stdout : "";
}

function serviceExists(launchctlText, label) {
  return launchctlText.split(/\r?\n/).some((line) => line.trim().endsWith(label));
}

async function ensureLaunchdBaseline() {
  const current = await launchctlList();
  if (serviceExists(current, "ai.openclaw.gateway") && serviceExists(current, "ai.openclaw.watchdog")) {
    return;
  }
  await log("warn", "launchd services missing, running silent install");
  await runCommand("/bin/bash", [path.join(PROJECT_ROOT, "ctl.sh"), "install"], 180000);
}

async function reconcileRuntime() {
  const status = await core.getStatusModel(true).catch(() => null);
  if (!status) {
    await runCommand("/bin/bash", [path.join(PROJECT_ROOT, "ctl.sh"), "start"], 60000);
    return core.getStatusModel(true).catch(() => null);
  }

  const gatewayOnline = status.gateway?.status === "online";
  const watchdogOnline = status.watchdog?.status === "running";
  if (gatewayOnline && watchdogOnline) {
    return status;
  }

  await runCommand("/bin/bash", [path.join(PROJECT_ROOT, "ctl.sh"), "start"], 60000);
  return core.getStatusModel(true).catch(() => null);
}

async function detectModel() {
  const gatewayLog = core?.config?.gatewayLog;
  if (!gatewayLog) {
    return "Unknown";
  }
  const result = await runCommand("/usr/bin/tail", ["-n", "200", gatewayLog], 10000);
  if (!result.ok) {
    return "Unknown";
  }
  const lines = result.stdout.split(/\r?\n/).reverse();
  for (const line of lines) {
    const m = line.match(/\[gateway\] agent model:\s*(.+)$/);
    if (m) {
      return m[1].trim();
    }
  }
  return "Unknown";
}

async function bootstrapSequence() {
  try {
    await ensureLocalDirs();
    await ensureExecutableScripts();
    await log("info", "bootstrap started", `root=${PROJECT_ROOT}`);

    const migration = await migrateTokenIfNeeded();
    await importCore(migration.token);

    if (!migration.token) {
      bootstrapState = {
        tokenMissing: true,
        status: null,
        model: "Unknown",
        startupError: null,
      };
      await log("warn", "gateway token missing, setup flow required");
      return bootstrapState;
    }

    await ensureLaunchdBaseline();
    const status = await reconcileRuntime();

    bootstrapState = {
      tokenMissing: false,
      status,
      model: await detectModel(),
      startupError: null,
    };
    await log("info", "bootstrap finished", `overall=${status?.overall?.status || "unknown"}`);
    return bootstrapState;
  } catch (error) {
    bootstrapState = {
      tokenMissing: false,
      status: null,
      model: "Unknown",
      startupError: error.message || "bootstrap failed",
    };
    await log("error", "bootstrap failed", bootstrapState.startupError);
    return bootstrapState;
  }
}

async function tailLogSource(source = "gateway", limit = 200) {
  if (!core?.config) {
    return { source, lines: [], error: "runtime core not ready" };
  }
  const lines = Math.max(10, Math.min(Number(limit || 200), 200));
  const filePath = source === "watchdog" ? core.config.watchdogLog : core.config.gatewayLog;
  const result = await runCommand("/usr/bin/tail", ["-n", String(lines), filePath], 10000);
  if (!result.ok) {
    return { source, lines: [], error: result.stderr || result.message || "failed to read logs" };
  }
  const rows = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => ({
      id: `${source}_${index}`,
      text: line,
    }));

  return { source, lines: rows };
}

async function runLockedAction(label, fn) {
  if (actionLock) {
    return {
      ok: false,
      error: {
        code: "ACTION_LOCKED",
        message: `Another action is running: ${label}`,
      },
    };
  }

  actionLock = true;
  try {
    return await fn();
  } finally {
    actionLock = false;
  }
}

async function waitForRuntimeHealthy(timeoutMs = 15000, intervalMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await core.getStatusModel(true).catch(() => null);
    const gatewayOnline = status?.gateway?.status === "online";
    const watchdogOnline = status?.watchdog?.status === "running";
    if (gatewayOnline && watchdogOnline) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return core.getStatusModel(true).catch(() => null);
}

async function restartAllServices() {
  if (!core?.config) {
    return {
      ok: false,
      error: {
        code: "CORE_NOT_READY",
        message: "Runtime core is not ready",
      },
    };
  }
  return runLockedAction("restart-all", async () => {
    const uid = String(process.getuid());
    const gatewayAttempt = {
      primary: await runCommand(core.config.nodeBin, [core.config.openclawCli, "gateway", "restart"], 60000),
      fallbackStop: null,
      fallbackBootout: null,
      fallbackStart: null,
      fallbackKickstart: null,
    };

    if (!gatewayAttempt.primary.ok) {
      gatewayAttempt.fallbackStop = await runCommand(core.config.nodeBin, [core.config.openclawCli, "gateway", "stop"], 20000);
      gatewayAttempt.fallbackBootout = await runCommand(
        "/bin/launchctl",
        ["bootout", `gui/${uid}/${core.config.gatewayLabel}`],
        15000,
      );
      gatewayAttempt.fallbackStart = await runCommand(core.config.nodeBin, [core.config.openclawCli, "gateway", "start"], 45000);
      gatewayAttempt.fallbackKickstart = await runCommand(
        "/bin/launchctl",
        ["kickstart", "-k", `gui/${uid}/${core.config.gatewayLabel}`],
        15000,
      );
    }

    await runCommand("/bin/launchctl", ["enable", `gui/${uid}/${core.config.watchdogLabel}`], 10000);
    const watchdogRestart = await runCommand("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${core.config.watchdogLabel}`], 15000);

    const status = await waitForRuntimeHealthy(15000, 1000);
    const ok = status?.gateway?.status === "online" && status?.watchdog?.status === "running";

    const primaryError = gatewayAttempt.primary.stderr || gatewayAttempt.primary.message || "";
    const fallbackError =
      gatewayAttempt.fallbackStart?.stderr ||
      gatewayAttempt.fallbackKickstart?.stderr ||
      watchdogRestart.stderr ||
      "";
    return {
      ok,
      status,
      detail: {
        gatewayAttempt,
        watchdogRestart,
      },
      error: ok
        ? null
        : {
            code: "RESTART_FAILED",
            message: primaryError || fallbackError || "restart failed",
          },
    };
  });
}

async function runTestChat(message) {
  if (!core?.config) {
    return {
      ok: false,
      error: {
        code: "CORE_NOT_READY",
        message: "Runtime core is not ready",
      },
    };
  }
  return runLockedAction("test-chat", async () => {
    const payload = await core.executeAction("test-chat", { message: String(message || "Health check") });
    if (!payload.ok) {
      return {
        ok: false,
        error: payload.error || { code: "TEST_CHAT_FAILED", message: "test chat failed" },
      };
    }

    return {
      ok: true,
      summary: payload.summary,
      reply: payload.result?.parsed?.reply || "",
      latencyMs: payload.result?.parsed?.meta?.durationMs ?? null,
      usage: payload.result?.parsed?.meta?.usage || null,
    };
  });
}

async function saveTokenAndRebootstrap(token) {
  if (!core?.config) {
    return {
      ok: false,
      error: {
        code: "CORE_NOT_READY",
        message: "Runtime core is not ready",
      },
    };
  }
  const clean = String(token || "").trim();
  if (!clean) {
    return {
      ok: false,
      error: {
        code: "TOKEN_EMPTY",
        message: "Token cannot be empty",
      },
    };
  }

  await setStoredToken(clean);
  process.env.OPENCLAW_GATEWAY_TOKEN = clean;
  core.config.gatewayToken = clean;

  await ensureLaunchdBaseline();
  const status = await reconcileRuntime();
  const model = await detectModel();

  bootstrapState = {
    tokenMissing: false,
    status,
    model,
    startupError: null,
  };

  return {
    ok: true,
    status,
    model,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#0b1020",
    title: "OpenClaw",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
  });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setTitle("OC");
  tray.setToolTip("OpenClaw");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open",
      click: () => {
        if (mainWindow?.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow?.show();
          mainWindow?.focus();
        }
      },
    },
    {
      label: "Check for Updates",
      click: () => {
        shell.openExternal(UPDATE_URL);
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

function setupMenu() {
  const template = [
    {
      label: "OpenClaw",
      submenu: [
        {
          label: "Check for Updates",
          click: () => shell.openExternal(UPDATE_URL),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function gracefulFullStop() {
  if (!core?.config) {
    return;
  }

  const uid = String(process.getuid());
  const labels = [core.config.gatewayLabel, core.config.watchdogLabel, core.config.consoleLabel].filter(Boolean);
  for (const label of labels) {
    await runCommand("/bin/launchctl", ["disable", `gui/${uid}/${label}`], 10000);
    await runCommand("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], 10000);
  }
}

ipcMain.handle("app:bootstrap", async () => bootstrapState);
ipcMain.handle("app:status", async () => {
  if (!core?.config) {
    return {
      ok: false,
      status: null,
      model: "Unknown",
      checkedAt: ts(),
      error: {
        code: "CORE_NOT_READY",
        message: "Runtime core is not ready",
      },
    };
  }
  const status = await core.getStatusModel(true).catch(() => null);
  return {
    ok: Boolean(status),
    status,
    model: await detectModel(),
    checkedAt: ts(),
  };
});
ipcMain.handle("logs:get", async (_event, source, limit) => tailLogSource(source, limit));
ipcMain.handle("action:restart-all", async () => restartAllServices());
ipcMain.handle("action:test-chat", async (_event, message) => runTestChat(message));
ipcMain.handle("token:save", async (_event, token) => saveTokenAndRebootstrap(token));
ipcMain.handle("app:retry", async () => {
  const result = await bootstrapSequence();
  return {
    ok: !result.startupError,
    ...result,
  };
});
ipcMain.handle("app:open-logs", async () => {
  const opened = await shell.openPath(APP_LOG_DIR);
  return { ok: !opened, message: opened || "" };
});
ipcMain.handle("app:check-updates", async () => {
  await shell.openExternal(UPDATE_URL);
  return { ok: true };
});

app.on("before-quit", (event) => {
  if (isQuitting) {
    return;
  }
  event.preventDefault();
  isQuitting = true;
  gracefulFullStop()
    .catch(async (error) => {
      await log("error", "graceful full stop failed", error.message || "unknown");
    })
    .finally(() => {
      app.exit(0);
    });
});

app.on("activate", () => {
  if (!mainWindow) {
    createWindow();
  }
  mainWindow?.show();
});

app.whenReady().then(async () => {
  await ensureLocalDirs();
  await bootstrapSequence();
  setupMenu();
  createWindow();
  createTray();
  await log("info", "desktop app ready");
});
