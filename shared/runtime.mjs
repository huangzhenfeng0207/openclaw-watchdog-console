import fs from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  APP_LOG_NAME,
  APP_SUPPORT_NAME,
  CONFIG_FILE,
  EXPORTS_DIR,
  INCIDENTS_FILE,
  SOCKET_NAME,
  STATUS_FILE,
} from "./constants.mjs";

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix = "id") {
  return `${prefix}_${randomUUID()}`;
}

export function summarizeError(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || String(error);
}

export function getRuntimePaths() {
  const supportDir = path.join(os.homedir(), "Library", "Application Support", APP_SUPPORT_NAME);
  const runtimeDir = path.join(supportDir, "runtime");
  const logDir = path.join(os.homedir(), "Library", "Logs", APP_LOG_NAME);
  const exportsDir = path.join(supportDir, EXPORTS_DIR);

  return {
    supportDir,
    runtimeDir,
    logDir,
    exportsDir,
    configPath: path.join(supportDir, CONFIG_FILE),
    statusPath: path.join(runtimeDir, STATUS_FILE),
    incidentsPath: path.join(runtimeDir, INCIDENTS_FILE),
    socketPath: path.join(runtimeDir, SOCKET_NAME),
    desktopLogPath: path.join(logDir, "desktop.log"),
    supervisorLogPath: path.join(logDir, "supervisor.log"),
    supervisorOutPath: path.join(logDir, "supervisor.out.log"),
    supervisorErrPath: path.join(logDir, "supervisor.err.log"),
  };
}

export async function ensureRuntimeDirs() {
  const paths = getRuntimePaths();
  await mkdir(paths.supportDir, { recursive: true });
  await mkdir(paths.runtimeDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
  await mkdir(paths.exportsDir, { recursive: true });
  await appendFile(paths.desktopLogPath, "").catch(() => undefined);
  await appendFile(paths.supervisorLogPath, "").catch(() => undefined);
  return paths;
}

export async function logLine(filePath, line) {
  await appendFile(filePath, `${nowIso()} ${line}\n`).catch(() => undefined);
}

export async function rotateLogFile(filePath, maxBytes = 10 * 1024 * 1024, keep = 3) {
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
  const siblings = (await readdir(dir).catch(() => []))
    .filter((name) => name.startsWith(`${base}.`))
    .sort()
    .reverse();
  for (const extra of siblings.slice(keep)) {
    await rm(path.join(dir, extra), { force: true }).catch(() => undefined);
  }
}

export async function readJson(filePath, fallback = null) {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function appendJsonLine(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function readJsonLines(filePath, limit = 50) {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }
  const items = raw
    .trim()
    .split(/\r?\n/)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return items.reverse();
}

export async function readTextTail(filePath, maxBytes = 250000) {
  try {
    const handle = await fs.promises.open(filePath, "r");
    const info = await handle.stat();
    const size = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, Math.max(0, info.size - size));
    await handle.close();
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

export async function clearSocketIfStale(filePath) {
  try {
    const info = await stat(filePath);
    if (info.isSocket()) {
      await rm(filePath, { force: true });
    }
  } catch {
    // ignore
  }
}

export function sanitizeFileName(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "-");
}
