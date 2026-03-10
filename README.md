# OpenClaw Guardian

Attach-only macOS desktop guardian for an existing local OpenClaw runtime.

Location: `/Users/huangzhenfeng/WorkSpace/openclaw-watchdog`

## What This Project Is

This repository now implements `OpenClaw Desktop Guardian` in `Attach` mode.

The app does not install or mutate the user's OpenClaw repo. It attaches to an existing OpenClaw checkout, probes it through the OpenClaw CLI, and keeps its own runtime state in macOS Application Support.

P0 scope:

- Attach a single local OpenClaw repo
- Read runtime truth from CLI probes
- Start / Stop / Restart
- Doctor
- Process-and-launchd-only Repair
- Read-only Git view for the attached repo
- Incident Memory with last incident + history drawer
- Export diagnostics bundle
- Independent supervisor that survives app quit

## Runtime Architecture

- `apps/desktop/`
  - Electron UI shell only
  - no recovery logic
- `supervisor/`
  - independent LaunchAgent
  - probe loop, auto recovery, incident storage, runtime ops
- `adapter/openclaw/`
  - OpenClaw CLI adapter
  - validation, probe, health, logs, doctor, gateway actions, Git read model
- `shared/`
  - runtime paths, shared constants, JSONL storage helpers

Legacy files remain in the repo for migration reference:

- `watchdog.sh`
- `ctl.sh`
- `install.sh`
- `console/`

They are no longer the product core for the desktop app.

## Source Of Truth

The Guardian home screen is built from OpenClaw CLI probes, not log parsing:

- `openclaw gateway status --json`
- `openclaw gateway probe --json`
- `openclaw gateway health`
- `openclaw logs --json`
- `openclaw doctor --non-interactive`

Logs remain an evidence layer only.

## App-Owned Runtime

Guardian writes only its own files under:

- `~/Library/Application Support/OpenClaw Guardian/`
- `~/Library/Logs/OpenClaw Guardian/`

Important files:

- `~/Library/Application Support/OpenClaw Guardian/config.json`
- `~/Library/Application Support/OpenClaw Guardian/runtime/status.json`
- `~/Library/Application Support/OpenClaw Guardian/runtime/incidents.jsonl`
- `~/Library/Application Support/OpenClaw Guardian/runtime/guardian.sock`
- `~/Library/LaunchAgents/ai.openclaw.guardian.supervisor.plist`

The attached OpenClaw repo is not rewritten by the desktop app.

## Desktop Behavior

- Window close:
  - hides the window
  - app remains available in the menu bar
- App quit (`Cmd+Q`):
  - quits the Electron UI
  - Guardian supervisor keeps running if installed
- Supervisor:
  - runs independently via `launchd`
  - keeps incident memory and optional auto recovery alive even when the window is closed

## Development

```bash
cd /Users/huangzhenfeng/WorkSpace/openclaw-watchdog
npm run desktop:install
npm run desktop:dev
```

## Build DMG

```bash
cd /Users/huangzhenfeng/WorkSpace/openclaw-watchdog
npm run desktop:build
```

Build output:

- `apps/desktop/dist/OpenClaw Guardian-0.1.0-arm64.dmg`

## Current Validation State

Verified during implementation:

- supervisor LaunchAgent installs and responds on Unix socket
- attach target works with `/Users/huangzhenfeng/openclaw`
- status model resolves `healthy`
- Git read-only view resolves branch / dirty / recent commits
- doctor action runs via CLI
- log view resolves via `openclaw logs --json`
- diagnostics export creates a zip bundle
- Electron app boots in development mode without immediate crash
- arm64 DMG builds successfully

## Notes

- Auto recovery is explicit opt-in and stored in Guardian config.
- Repair is constrained to process / launchd scope only.
- Packaging currently ships the new `adapter / shared / supervisor` runtime, not the old console stack.
