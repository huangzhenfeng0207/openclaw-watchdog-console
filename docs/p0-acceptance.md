# OpenClaw Desktop P0 Acceptance

Date: 2026-03-10  
Scope: `openclaw-watchdog` desktop MVP

## Result

All locked P0 items were implemented and validated on macOS arm64.

## Acceptance Checklist

1. Desktop shell can boot and initialize runtime  
Status: PASS
- Evidence: `~/Library/Logs/OpenClaw/desktop.log` contains:
  - `bootstrap started`
  - `bootstrap finished | overall=healthy`
  - `desktop app ready`

2. Secure token handling (safe storage + migration)  
Status: PASS
- Evidence:
  - token encrypted file exists: `~/Library/Application Support/OpenClaw/secure-store.json`
  - `.env` token line is masked after migration.

3. Runtime health projection works  
Status: PASS
- Evidence:
  - `GET /api/status` returns `overall.status=healthy`
  - watchdog state is fresh (`lastLoopAt`, `lastHealthResult`) via new state writer.

4. Logs surface works for gateway/watchdog  
Status: PASS
- Evidence:
  - `GET /api/logs?source=watchdog&limit=5` returns recent structured lines.

5. Restart action works  
Status: PASS
- Evidence:
  - `POST /api/actions/restart-gateway` returns `ok=true`
  - fallback restart path added for launchctl bootstrap edge cases.

6. Test chat action works and returns metadata  
Status: PASS
- Evidence:
  - `POST /api/actions/test-chat` returns:
    - parsed `reply`
    - `durationMs`
    - token `usage`

7. DMG packaging output exists (macOS arm64)  
Status: PASS
- Evidence:
  - `apps/desktop/dist/OpenClaw-0.1.0-arm64.dmg`
  - `apps/desktop/dist/OpenClaw-0.1.0-arm64.dmg.blockmap`

## Notes

- Development termination via terminal `Ctrl+C` bypasses app graceful quit path.  
  Use normal app quit (`Cmd+Q`) in production usage.
- Code signing/notarization is intentionally out of scope for this phase.
