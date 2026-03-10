import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { readTextTail, summarizeError } from "../../shared/runtime.mjs";

const execFileAsync = promisify(execFile);
const NODE_CANDIDATES = [
  process.env.OPENCLAW_NODE_PATH,
  "/opt/homebrew/opt/node/bin/node",
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
].filter(Boolean);

function normalizeRepoRoot(repoRoot) {
  return path.resolve(String(repoRoot || "").trim());
}

export async function resolveNodePath() {
  for (const candidate of NODE_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // ignore
    }
  }

  const fallback = await execFileAsync("/usr/bin/which", ["node"], {
    env: process.env,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  }).catch(() => null);
  if (fallback?.stdout?.trim()) {
    return fallback.stdout.trim();
  }
  throw new Error("Node runtime not found for OpenClaw CLI");
}

function cliCandidates(repoRoot) {
  return [
    path.join(repoRoot, "openclaw.mjs"),
    path.join(repoRoot, "dist", "index.js"),
  ];
}

async function resolveCliPath(repoRoot) {
  for (const candidate of cliCandidates(repoRoot)) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  throw new Error("OpenClaw CLI entry not found in selected directory");
}

export async function runOpenClaw(target, args, options = {}) {
  const nodePath = target.nodePath || (await resolveNodePath());
  const cliPath = target.resolvedCliPath || (await resolveCliPath(target.repoRoot));
  const timeoutMs = options.timeoutMs || 30000;
  const cwd = target.repoRoot;
  try {
    const result = await execFileAsync(nodePath, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        OPENCLAW_PROJECT_DIR: target.repoRoot,
      },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
      nodePath,
      cliPath,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || "").trim(),
      message: error.message || "OpenClaw command failed",
      nodePath,
      cliPath,
    };
  }
}

async function runGit(repoRoot, args) {
  try {
    const result = await execFileAsync("/usr/bin/git", args, {
      cwd: repoRoot,
      env: process.env,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: (result.stdout || "").trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || "").trim(),
      message: error.message || "git failed",
    };
  }
}

export async function getGitInfo(repoRoot) {
  const inside = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    return {
      available: false,
      branch: null,
      dirty: false,
      dirtyCount: 0,
      ahead: 0,
      behind: 0,
      recentCommit: null,
      recentCommits: [],
    };
  }

  const [branch, dirty, aheadBehind, recent] = await Promise.all([
    runGit(repoRoot, ["branch", "--show-current"]),
    runGit(repoRoot, ["status", "--porcelain"]),
    runGit(repoRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    runGit(repoRoot, ["log", "--pretty=format:%H%x09%h%x09%cs%x09%s", "-5"]),
  ]);

  let ahead = 0;
  let behind = 0;
  if (aheadBehind.ok && aheadBehind.stdout) {
    const parts = aheadBehind.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10));
    if (parts.length >= 2) {
      behind = Number.isFinite(parts[0]) ? parts[0] : 0;
      ahead = Number.isFinite(parts[1]) ? parts[1] : 0;
    }
  }

  const recentCommits = recent.ok
    ? recent.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [hash, shortHash, date, subject] = line.split("\t");
          return { hash, shortHash, date, subject };
        })
    : [];

  return {
    available: true,
    branch: branch.ok ? branch.stdout || "detached" : "unknown",
    dirty: Boolean(dirty.ok && dirty.stdout.trim()),
    dirtyCount: dirty.ok ? dirty.stdout.split(/\r?\n/).filter(Boolean).length : 0,
    ahead,
    behind,
    recentCommit: recentCommits[0] || null,
    recentCommits,
  };
}

export async function validateTarget(repoRoot) {
  const normalizedRoot = normalizeRepoRoot(repoRoot);
  const info = {
    repoRoot: normalizedRoot,
    resolvedCliPath: null,
    resolvedConfigPath: path.join(os.homedir(), ".openclaw", "openclaw.json"),
    gatewayPort: null,
    gatewayLabel: "ai.openclaw.gateway",
    nodePath: null,
    version: null,
  };

  try {
    const directory = await stat(normalizedRoot);
    if (!directory.isDirectory()) {
      throw new Error("Selected path is not a directory");
    }
    info.nodePath = await resolveNodePath();
    info.resolvedCliPath = await resolveCliPath(normalizedRoot);
    const versionResult = await runOpenClaw(info, ["--version"], { timeoutMs: 10000 });
    if (!versionResult.ok) {
      throw new Error(versionResult.message || versionResult.stderr || "Unable to read OpenClaw version");
    }
    info.version = versionResult.stdout || "unknown";
    const git = await getGitInfo(normalizedRoot);
    return { ok: true, ...info, git };
  } catch (error) {
    return {
      ok: false,
      ...info,
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
      error: summarizeError(error),
    };
  }
}

function parseJsonResult(result, fallbackMessage) {
  if (!result.ok) {
    return { ok: false, error: result.message || result.stderr || fallbackMessage };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout || "null") };
  } catch (error) {
    return { ok: false, error: `${fallbackMessage}: ${summarizeError(error)}` };
  }
}

export async function getGatewayStatus(target) {
  const result = await runOpenClaw(target, ["gateway", "status", "--json"], { timeoutMs: 15000 });
  return parseJsonResult(result, "gateway status failed");
}

export async function probeGateway(target) {
  const result = await runOpenClaw(target, ["gateway", "probe", "--json"], { timeoutMs: 15000 });
  return parseJsonResult(result, "gateway probe failed");
}

export async function healthCheck(target) {
  const result = await runOpenClaw(target, ["gateway", "health"], { timeoutMs: 10000 });
  return {
    ok: result.ok,
    output: result.stdout || result.stderr || "",
    error: result.ok ? null : result.message || result.stderr || "gateway health failed",
  };
}

export async function runDoctor(target) {
  const result = await runOpenClaw(target, ["doctor", "--non-interactive"], { timeoutMs: 30000 });
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const summary = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      if (line.includes("OPENCLAW")) {
        return false;
      }
      if (/^[▀▄█░\s]+$/.test(line)) {
        return false;
      }
      return !/^[┌│◇├└]/.test(line);
    })
    .slice(0, 20);
  return {
    ok: result.ok,
    text,
    summary,
    error: result.ok ? null : result.message || result.stderr || "doctor failed",
  };
}

function parseRpcLogLines(raw) {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .flatMap((entry) => {
      if (entry.type === "log") {
        const message = entry.message || "";
        if (message.includes("🦞 OPENCLAW 🦞") || /^[▀▄█░\s]+$/.test(message)) {
          return [];
        }
        return [{
          time: entry.time || null,
          level: entry.level || "info",
          text: message,
          raw: entry.raw || null,
        }];
      }
      if (entry.type === "notice") {
        return [{ time: null, level: "notice", text: entry.message || "", raw: null }];
      }
      return [];
    });
}

function fallbackLogPath(source) {
  const base = path.join(os.homedir(), ".openclaw", "logs");
  if (source === "gateway") {
    return path.join(base, "gateway.log");
  }
  return path.join(base, "console.log");
}

export async function getLogs(target, options = {}) {
  const source = options.source || "gateway";
  const limit = Number.parseInt(options.limit || 200, 10);

  if (source === "gateway" && target?.repoRoot) {
    const rpc = await runOpenClaw(target, ["logs", "--json", "--limit", String(limit), "--timeout", "5000"], {
      timeoutMs: 8000,
    });
    if (rpc.ok && rpc.stdout.trim()) {
      return {
        ok: true,
        source,
        mode: "rpc",
        lines: parseRpcLogLines(rpc.stdout).slice(-limit),
      };
    }
  }

  const tailPath = options.filePath || fallbackLogPath(source);
  const text = await readTextTail(tailPath);
  const lines = text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => ({ time: null, level: "file", text: line, raw: null }));
  return {
    ok: true,
    source,
    mode: "file",
    filePath: tailPath,
    lines,
  };
}

export async function gatewayStart(target) {
  return runOpenClaw(target, ["gateway", "start"], { timeoutMs: 30000 });
}

export async function gatewayStop(target) {
  return runOpenClaw(target, ["gateway", "stop"], { timeoutMs: 30000 });
}

export async function gatewayRestart(target) {
  return runOpenClaw(target, ["gateway", "restart"], { timeoutMs: 30000 });
}

export async function gatewayInstall(target) {
  return runOpenClaw(target, ["gateway", "install", "--force"], { timeoutMs: 45000 });
}
