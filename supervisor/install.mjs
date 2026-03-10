import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { SUPERVISOR_LABEL } from "../shared/constants.mjs";
import { ensureRuntimeDirs, getRuntimePaths, summarizeError } from "../shared/runtime.mjs";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);

function plistEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildPlist({ nodePath, agentPath, runtimePaths }) {
  const args = [nodePath, agentPath]
    .map((value) => `      <string>${plistEscape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SUPERVISOR_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${plistEscape(path.dirname(agentPath))}</string>
    <key>StandardOutPath</key>
    <string>${plistEscape(runtimePaths.supervisorOutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(runtimePaths.supervisorErrPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${plistEscape(process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")}</string>
      <key>HOME</key>
      <string>${plistEscape(os.homedir())}</string>
    </dict>
  </dict>
</plist>
`;
}

async function runLaunchctl(args) {
  try {
    const result = await execFileAsync("/bin/launchctl", args, {
      env: process.env,
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || "").trim(),
      message: error.message || "launchctl failed",
    };
  }
}

export function getSupervisorPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${SUPERVISOR_LABEL}.plist`);
}

export async function ensureSupervisorInstalled({ agentPath = __filename, nodePath } = {}) {
  if (!nodePath) {
    throw new Error("nodePath is required to install supervisor");
  }

  const runtimePaths = await ensureRuntimeDirs();
  const plistPath = getSupervisorPlistPath();
  const plist = buildPlist({ nodePath, agentPath, runtimePaths });
  await writeFile(plistPath, plist, "utf8");

  const uid = process.env.UID || String(process.getuid?.() || "501");
  await runLaunchctl(["bootout", `gui/${uid}/${SUPERVISOR_LABEL}`]).catch(() => undefined);
  await runLaunchctl(["bootout", `gui/${uid}`, plistPath]).catch(() => undefined);

  const bootstrap = await runLaunchctl(["bootstrap", `gui/${uid}`, plistPath]);
  if (!bootstrap.ok) {
    throw new Error(bootstrap.message || bootstrap.stderr || "Failed to bootstrap supervisor");
  }

  await runLaunchctl(["kickstart", "-k", `gui/${uid}/${SUPERVISOR_LABEL}`]).catch(() => undefined);

  return { ok: true, plistPath, runtimePaths };
}

export async function restartSupervisorLaunchd() {
  const uid = process.env.UID || String(process.getuid?.() || "501");
  const result = await runLaunchctl(["kickstart", "-k", `gui/${uid}/${SUPERVISOR_LABEL}`]);
  if (!result.ok) {
    throw new Error(result.message || result.stderr || "Failed to restart supervisor");
  }
  return result;
}

export async function listSupervisorLaunchd() {
  const uid = process.env.UID || String(process.getuid?.() || "501");
  const result = await runLaunchctl(["print", `gui/${uid}/${SUPERVISOR_LABEL}`]);
  return {
    ok: result.ok,
    detail: result.ok ? result.stdout : result.stderr || result.message || summarizeError(result),
  };
}
