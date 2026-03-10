# Desktop Architecture Decision Record

Date: 2026-03-10
Status: Accepted
Scope: openclaw-watchdog desktopization (macOS arm64)

## Context

The project already has:
- watchdog shell runtime (`watchdog.sh`)
- launchd-managed gateway/watchdog services
- web console API (`console/server.mjs`) and UI (`console/web`)

The goal is a local desktop app with premium UX while preserving runtime behavior.

## Decisions

1. Desktop framework: Electron
- Packaging tool is locked to `electron-builder`.
- Target output is `.dmg` only.
- Platform target is `macOS arm64` only for this phase.

2. Runtime ownership
- Watchdog remains the only autonomous recovery brain.
- Desktop app is a projection/control plane, not an autonomous orchestrator.

3. Transport strategy
- Extracted `console/core/api.mjs` as transport-agnostic core.
- Keep `console/server.mjs` as HTTP compatibility adapter.
- Desktop uses IPC + core module directly.

4. Security strategy
- Use Electron `safeStorage` + encrypted local file under Application Support.
- Migrate token from `.env` into secure storage.
- Mask plaintext token in `.env` after migration.

5. UX strategy
- Three fixed tabs: `Overview`, `Logs`, `Actions`.
- English-only desktop UI.
- P0 actions: `Restart`, `Test Chat`.
- Logs: direct local file tailing (`gateway`/`watchdog`) with pause auto-scroll.

6. Lifecycle strategy
- Window close hides app to menu bar tray.
- `Cmd+Q` performs graceful stop with launchd `bootout/disable` for managed services.

## Consequences

Positive:
- Keeps existing runtime stable.
- Enables desktop shell without breaking HTTP console compatibility.
- Avoids native module complexity from `keytar`.

Tradeoffs:
- Need to maintain both IPC usage and HTTP adapter compatibility.
- Desktop app must manage lifecycle edge cases to avoid service drift.

## Non-goals for this phase

- No notarization automation.
- No auto-update pipeline.
- No timeline/backup UI in P0.
