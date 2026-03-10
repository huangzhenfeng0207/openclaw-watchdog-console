import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import fs from "node:fs";
import { appendFile, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEV_ROOT = path.resolve(__dirname, "..", "..");
const UPDATE_URL = "https://github.com/huangzhenfeng0207/openclaw-watchdog-console/releases";

let mainWindow = null;
let tray = null;
let isQuitting = false;
let modulesPromise = null;
let bootstrapSnapshot = null;

function appRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "app-root") : DEV_ROOT;
}

function ts() {
  return new Date().toISOString();
}

function runtimePathsFallback() {
  const supportDir = path.join(os.homedir(), "Library", "Application Support", "OpenClaw Guardian");
  const logDir = path.join(os.homedir(), "Library", "Logs", "OpenClaw Guardian");
  return {
    supportDir,
    runtimeDir: path.join(supportDir, "runtime"),
    logDir,
    desktopLogPath: path.join(logDir, "desktop.log"),
  };
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

async function desktopLog(level, message, details = "") {
  const { desktopLogPath, logDir } = runtimePathsFallback();
  await mkdir(logDir, { recursive: true });
  await appendFile(desktopLogPath, "").catch(() => undefined);
  await rotateLogFile(desktopLogPath);
  await appendFile(
    desktopLogPath,
    `${ts()} [desktop][${level}] ${message}${details ? ` | ${details}` : ""}\n`,
  ).catch(() => undefined);
}

async function importAppModule(relativePath) {
  const href = pathToFileURL(path.join(appRoot(), relativePath)).href;
  return import(href);
}

async function ensureModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      importAppModule("shared/runtime.mjs"),
      importAppModule("adapter/openclaw/index.mjs"),
      importAppModule("supervisor/install.mjs"),
      importAppModule("supervisor/client.mjs"),
    ]).then(([runtime, adapter, install, client]) => ({ runtime, adapter, install, client }));
  }
  return modulesPromise;
}

async function callSupervisor(method, params = {}, timeoutMs = 15000) {
  const modules = await ensureModules();
  return modules.client.requestSupervisor(method, params, { timeoutMs });
}

async function waitForSupervisor() {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await callSupervisor("ping", {}, 2000);
      return true;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error("Supervisor did not become ready");
}

async function ensureSupervisorReady() {
  const modules = await ensureModules();
  await modules.runtime.ensureRuntimeDirs();

  try {
    await callSupervisor("ping", {}, 1500);
    return;
  } catch {
    // install or recover below
  }

  const nodePath = await modules.adapter.resolveNodePath();
  const agentPath = path.join(appRoot(), "supervisor", "agent.mjs");
  await modules.install.ensureSupervisorInstalled({ agentPath, nodePath });
  await waitForSupervisor();
}

async function getBootstrapState() {
  try {
    await ensureSupervisorReady();
    const payload = await callSupervisor("getStatus", {}, 20000);
    bootstrapSnapshot = {
      ok: true,
      status: payload.status,
      attachRequired: payload.status?.target === "missing",
      invalidTarget: payload.status?.target === "invalid",
      startupError: null,
    };
    return bootstrapSnapshot;
  } catch (error) {
    await desktopLog("error", "bootstrap failed", error.message || String(error));
    bootstrapSnapshot = {
      ok: false,
      status: null,
      attachRequired: false,
      invalidTarget: false,
      startupError: error.message || String(error),
    };
    return bootstrapSnapshot;
  }
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <rect x="3" y="3" width="16" height="16" rx="5" fill="#dfe8ff" opacity="0.96"/>
      <circle cx="11" cy="11" r="3.3" fill="#0d1220"/>
    </svg>`;
  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
    .resize({ width: 18, height: 18 });
}

function showWindow() {
  if (!mainWindow) {
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (!mainWindow) {
    return;
  }
  mainWindow.hide();
}

function toggleWindow() {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isVisible()) {
    hideWindow();
  } else {
    showWindow();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1120,
    minHeight: 760,
    title: "OpenClaw 守护桌面版",
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window",
    backgroundColor: "#05070f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    hideWindow();
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("OpenClaw 守护桌面版");
  tray.on("click", toggleWindow);

  const menu = Menu.buildFromTemplate([
    { label: "打开主窗口", click: showWindow },
    {
      label: "检查更新",
      click: () => shell.openExternal(UPDATE_URL),
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

async function chooseTargetDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 OpenClaw 仓库",
    buttonLabel: "连接仓库",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) {
    return null;
  }
  return result.filePaths[0];
}

function currentRepoRoot() {
  return bootstrapSnapshot?.status?.targetInfo?.repoRoot || null;
}

async function openRepoInTerminal(repoRoot) {
  await execFileAsync("/usr/bin/open", ["-a", "Terminal", repoRoot], {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
}

function wrap(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      await desktopLog("error", "IPC failed", error.message || String(error));
      return {
        ok: false,
        error: {
          message: error.message || String(error),
        },
      };
    }
  };
}

async function registerIpc() {
  ipcMain.handle(
    "app:bootstrap",
    wrap(async () => getBootstrapState()),
  );

  ipcMain.handle(
    "app:status",
    wrap(async () => {
      await ensureSupervisorReady();
      const payload = await callSupervisor("getStatus", {}, 20000);
      bootstrapSnapshot = { ...(bootstrapSnapshot || {}), status: payload.status };
      return { ok: true, status: payload.status };
    }),
  );

  ipcMain.handle(
    "app:history",
    wrap(async () => {
      await ensureSupervisorReady();
      const payload = await callSupervisor("getHistory", {}, 10000);
      return { ok: true, ...payload };
    }),
  );

  ipcMain.handle(
    "app:choose-target",
    wrap(async () => {
      const repoRoot = await chooseTargetDirectory();
      return { ok: true, repoRoot };
    }),
  );

  ipcMain.handle(
    "app:attach-target",
    wrap(async (_event, repoRoot) => {
      await ensureSupervisorReady();
      const payload = await callSupervisor("attachTarget", { repoRoot }, 30000);
      bootstrapSnapshot = { ...(bootstrapSnapshot || {}), status: payload.status };
      return { ok: true, status: payload.status, config: payload.config };
    }),
  );

  ipcMain.handle(
    "app:set-auto-recovery",
    wrap(async (_event, enabled) => {
      await ensureSupervisorReady();
      const payload = await callSupervisor("setAutoRecovery", { enabled }, 15000);
      bootstrapSnapshot = { ...(bootstrapSnapshot || {}), status: payload.status };
      return { ok: true, ...payload };
    }),
  );

  ipcMain.handle(
    "logs:get",
    wrap(async (_event, source, limit) => {
      await ensureSupervisorReady();
      const payload = await callSupervisor("getLogs", { source, limit }, 15000);
      return { ok: true, ...payload };
    }),
  );

  ipcMain.handle(
    "action:run",
    wrap(async (_event, name) => {
      await ensureSupervisorReady();
      const payload = await callSupervisor("runAction", { name }, 60000);
      if (payload?.status) {
        bootstrapSnapshot = { ...(bootstrapSnapshot || {}), status: payload.status };
      }
      return { ok: true, ...payload };
    }),
  );

  ipcMain.handle(
    "app:open-logs",
    wrap(async () => {
      const modules = await ensureModules();
      const paths = modules.runtime.getRuntimePaths();
      await shell.openPath(paths.logDir);
      return { ok: true, path: paths.logDir };
    }),
  );

  ipcMain.handle(
    "app:check-updates",
    wrap(async () => {
      await shell.openExternal(UPDATE_URL);
      return { ok: true };
    }),
  );

  ipcMain.handle(
    "repo:open-finder",
    wrap(async () => {
      const repoRoot = currentRepoRoot();
      if (!repoRoot) {
        throw new Error("当前未连接仓库");
      }
      await shell.openPath(repoRoot);
      return { ok: true };
    }),
  );

  ipcMain.handle(
    "repo:open-terminal",
    wrap(async () => {
      const repoRoot = currentRepoRoot();
      if (!repoRoot) {
        throw new Error("当前未连接仓库");
      }
      await openRepoInTerminal(repoRoot);
      return { ok: true };
    }),
  );
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await desktopLog("info", "App launching", appRoot());
  createWindow();
  createTray();
  await registerIpc();

  try {
    await getBootstrapState();
  } catch {
    // bootstrap error is rendered in the UI
  }

  app.on("activate", () => {
    showWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});
