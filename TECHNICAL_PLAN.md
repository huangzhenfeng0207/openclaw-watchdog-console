# OpenClaw Watchdog Desktop Plan (Executed)

Date: 2026-03-10  
Scope: `/Users/huangzhenfeng/WorkSpace/openclaw-watchdog`

## Objective

Turn `openclaw-watchdog` into a local macOS desktop app without replacing watchdog autonomy.

## Locked Constraints

- Project scope: `openclaw-watchdog` only
- Platform: macOS arm64 only
- Package: `.dmg` via `electron-builder`
- UI language: English only
- P0 features only:
  - Status Overview
  - Real-time Logs
  - Restart
  - Test Chat
- Security: token encryption with Electron `safeStorage`

## Architecture

1. `watchdog.sh`
- Autonomous recovery engine (single decision brain)
- launchd-managed lifecycle

2. `console/core/api.mjs`
- Unified runtime projection and action wrapper
- Reused by both HTTP server and desktop app

3. `console/server.mjs`
- Thin HTTP adapter for compatibility

4. `apps/desktop`
- Electron main/renderer shell
- UI expression layer only

## Delivered Work

1. Core extraction
- Introduced `console/core/api.mjs` as reusable runtime core.
- Refactored `console/server.mjs` to a thin adapter.

2. Desktop shell
- Added `apps/desktop` with:
  - `main.mjs`
  - `preload.cjs`
  - `ui/index.html`, `ui/styles.css`, `ui/app.js`

3. Security
- Implemented token secure storage at:
  - `~/Library/Application Support/OpenClaw/secure-store.json`
- Added automatic token migration from `.env` with masking.

4. Runtime stability
- Added restart fallback logic for gateway action path.
- Added watchdog `state.env` writer for fresh runtime telemetry.

5. Packaging
- Built arm64 DMG using `electron-builder`:
  - `apps/desktop/dist/OpenClaw-0.1.0-arm64.dmg`

## Validation Artifacts

- Baseline: `docs/baseline.md`
- ADR: `docs/desktop-adr.md`
- P0 acceptance: `docs/p0-acceptance.md`
