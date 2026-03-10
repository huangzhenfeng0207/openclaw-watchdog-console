# OpenClaw Guardian P0 Technical Plan

Date: 2026-03-10  
Scope: `/Users/huangzhenfeng/WorkSpace/openclaw-watchdog`

## Product Definition

P0 is `Attach` mode only.

The desktop app attaches to an existing local OpenClaw repository and manages observation, recovery, diagnostics, and runtime memory without modifying the user's repository configuration.

## Locked Constraints

- Single attached target only
- Existing OpenClaw repo only
- No OpenClaw installation flow in P0
- No repo write operations
- No `doctor --repair`
- No Telegram / Webhook product surface in P0
- No multiple restart implementations in parallel
- No Electron-owned recovery logic

## Architecture

### Desktop

`apps/desktop`

- BrowserWindow + tray/menu bar shell
- IPC bridge only
- no recovery brain
- quit does not stop the independent supervisor

### Supervisor

`supervisor/agent.mjs`

- LaunchAgent-managed
- owns probe loop
- owns auto recovery
- owns runtime incident memory
- exposes local control API over Unix socket

### OpenClaw Adapter

`adapter/openclaw/index.mjs`

- validates repo root
- resolves CLI entry + Node runtime
- runs:
  - `gateway status --json`
  - `gateway probe --json`
  - `gateway health`
  - `logs --json`
  - `doctor --non-interactive`
- wraps gateway start / stop / restart / install
- exposes read-only Git summary for attached repo

### Shared Runtime

`shared/`

- Application Support / Logs path model
- JSON / JSONL helpers
- log rotation helpers
- shared constants for status and repair enums

## Runtime State Model

Guardian status includes:

- `target`
  - `missing | invalid | attached`
- `install`
  - `cliFound | repoValid | version`
- `service`
  - `loaded | pid | state`
- `port`
  - `listening | listeners | port`
- `health`
  - `state | ok | lastCheckedAt | output`
- `recovery`
  - `enabled | state | lastAction | lastAt | lastResult`
- `git`
  - `branch | dirty | ahead | behind | recentCommit | recentCommits`
- `incident`
  - `lastReason | lastAction | lastAt | lastResult | successRate | repeatedSignature`

## Operations Surface

P0 actions implemented through the supervisor:

- `attachTarget`
- `setAutoRecovery`
- `start`
- `stop`
- `restart`
- `doctor`
- `repair`
- `exportDiagnostics`
- `getLogs`
- `getHistory`

Repair is constrained to process + launchd scope:

- `restart_gateway`
- `reinstall_gateway_launchd`
- internal support for:
  - `restart_supervisor`
  - `reinstall_supervisor_launchd`

## Incident Memory

Guardian stores incident history in:

- `~/Library/Application Support/OpenClaw Guardian/runtime/incidents.jsonl`

Each record contains:

- trigger
- probe snapshot
- doctor summary
- repair action
- duration
- result
- crash signature

The UI uses:

- `Last Incident` on the overview screen
- `History Drawer` for structured incident history

## Launchd Model

Guardian supervisor installs as:

- label: `ai.openclaw.guardian.supervisor`
- plist: `~/Library/LaunchAgents/ai.openclaw.guardian.supervisor.plist`

The supervisor survives UI quit and keeps monitoring the attached target.

## Packaging

Electron packaging now includes only the new runtime modules:

- `adapter/`
- `shared/`
- `supervisor/`

Legacy `console/` and shell watchdog files are not shipped as desktop runtime dependencies anymore.

## Validation Performed

Completed during implementation:

- target validation against `/Users/huangzhenfeng/openclaw`
- supervisor installation and socket handshake
- attach target flow
- healthy status projection
- Git summary projection
- doctor action
- gateway logs action
- diagnostics export zip
- Electron development boot
- DMG build for arm64

## Remaining Follow-Up

Possible P1 work, intentionally out of P0:

- finer crash signature normalization
- richer log filtering
- multiple target support
- managed OpenClaw mode
- signed/notarized release pipeline
