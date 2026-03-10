# OpenClaw Watchdog Desktop

Local watchdog console for OpenClaw with auto-recovery, runtime visibility, logs, and operator actions.

Location: `/Users/huangzhenfeng/WorkSpace/openclaw-watchdog`

## What This Project Is

This repository provides a macOS desktop app shell for the existing OpenClaw watchdog runtime.

- Desktop UI (Electron): `Overview / Logs / Actions`
- Runtime core: watchdog + gateway + launchd
- Control/inspection core: `console/core/api.mjs`

The desktop app does not replace watchdog recovery logic. Watchdog remains the only autonomous recovery engine.

## Current Scope (MVP)

- Platform: macOS arm64
- Package format: `.dmg`
- Language: English UI only
- P0 features:
  - Status Overview
  - Real-time Logs (gateway/watchdog, pause supported)
  - One-click restart (`gateway + watchdog`)
  - Test Chat

## Project Structure

- `apps/desktop/`: Electron desktop shell
- `console/core/api.mjs`: reusable runtime/status/action core
- `console/server.mjs`: HTTP adapter for the same core
- `watchdog.sh`: watchdog daemon loop
- `ctl.sh`: runtime control script
- `install.sh`: idempotent launchd install/bootstrap

## Run Desktop App (Development)

```bash
cd /Users/huangzhenfeng/WorkSpace/openclaw-watchdog
npm run desktop:install
npm run desktop:dev
```

## Build DMG (macOS arm64)

```bash
cd /Users/huangzhenfeng/WorkSpace/openclaw-watchdog
npm run desktop:build
```

Output:

- `apps/desktop/dist/OpenClaw-0.1.0-arm64.dmg`

## Runtime Behavior

- App startup:
  - checks/bootstraps runtime
  - auto-attaches if runtime is already healthy
  - silent install/reconcile when required
- Window close (`red x`):
  - hides window
  - app remains in tray/menu bar
- Full quit (`Cmd+Q`):
  - performs graceful full stop (`launchctl disable/bootout`) for managed services

## Token Security

Token storage uses Electron `safeStorage` with encrypted local file:

- `~/Library/Application Support/OpenClaw/secure-store.json`

If a plaintext token exists in `.env`, desktop startup migrates it automatically and masks the old `.env` token line.

## Logs

Desktop app log:

- `~/Library/Logs/OpenClaw/desktop.log` (rotated, 10MB x 3)

Runtime logs:

- `~/.openclaw/logs/gateway.log`
- `~/.openclaw/logs/gateway.err.log`
- `~/.openclaw/logs/watchdog.log`
- `~/.openclaw/logs/watchdog.err.log`

## CLI Runtime Commands (Still Available)

```bash
cd /Users/huangzhenfeng/WorkSpace/openclaw-watchdog
./ctl.sh install
./ctl.sh start
./ctl.sh stop
./ctl.sh restart
./ctl.sh status
./ctl.sh postboot-check
./ctl.sh test-chat "Reply with: watchdog healthy"
```

## Key Docs

- `docs/desktop-adr.md`: desktop architecture decisions
- `docs/baseline.md`: baseline freeze and environment capture
- `docs/p0-acceptance.md`: P0 acceptance evidence
