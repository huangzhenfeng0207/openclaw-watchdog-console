# OpenClaw Guardian P0 Acceptance

Date: 2026-03-10  
Scope: Attach-only desktop guardian MVP

## Acceptance Result

P0 implementation is in place and the core runtime chain has been validated on macOS arm64.

## Acceptance Checklist

1. Independent supervisor LaunchAgent exists  
Status: PASS
- Evidence:
  - `~/Library/LaunchAgents/ai.openclaw.guardian.supervisor.plist`
  - Unix socket responds at `~/Library/Application Support/OpenClaw Guardian/runtime/guardian.sock`

2. Attach mode resolves an existing OpenClaw repo  
Status: PASS
- Evidence:
  - attached target: `/Users/huangzhenfeng/openclaw`
  - target validation resolves `openclaw.mjs`, Node runtime, and version `2026.3.8`

3. Runtime status model resolves from CLI probes  
Status: PASS
- Evidence:
  - `gateway status --json`
  - `gateway probe --json`
  - `gateway health`
  - projected overall state: `healthy`

4. Read-only Git surface works for the attached repo  
Status: PASS
- Evidence:
  - branch: `main`
  - dirty state: clean
  - recent commit list resolves

5. Doctor action is read-only and executes through OpenClaw CLI  
Status: PASS
- Evidence:
  - `runAction(name="doctor")` returns structured summary lines
  - no `doctor --repair` usage in P0 path

6. Logs surface resolves through OpenClaw logs RPC with local fallback path available  
Status: PASS
- Evidence:
  - `getLogs(source="gateway")` returns structured lines via `openclaw logs --json`
  - supervisor log file exists in `~/Library/Logs/OpenClaw Guardian/`

7. Incident Memory is persisted outside the target repo  
Status: PASS
- Evidence:
  - `~/Library/Application Support/OpenClaw Guardian/runtime/incidents.jsonl`
  - `Last Incident` summary resolves after attach / doctor / export actions

8. Diagnostics export works  
Status: PASS
- Evidence:
  - zip created under:
    `~/Library/Application Support/OpenClaw Guardian/exports/`

9. Electron desktop shell boots on development launch  
Status: PASS
- Evidence:
  - `npm --prefix apps/desktop run dev` launches without immediate crash
  - desktop log entry written to `~/Library/Logs/OpenClaw Guardian/desktop.log`

10. arm64 DMG builds successfully  
Status: PASS
- Evidence:
  - `apps/desktop/dist/OpenClaw Guardian-0.1.0-arm64.dmg`
  - `apps/desktop/dist/OpenClaw Guardian-0.1.0-arm64.dmg.blockmap`

## Notes

- Auto recovery remains explicit opt-in.
- Start / Stop / Restart wiring is implemented, but disruptive lifecycle actions were not stress-tested against a busy live runtime to avoid interrupting active user work.
- Legacy repo files still exist as migration reference, but the new desktop runtime depends on `adapter / shared / supervisor`.
