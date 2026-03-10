# OpenClaw Watchdog Baseline Report

- Generated at: 2026-03-10T20:47:24+0800
- Plan node: Node A (Baseline Freeze)
- Snapshot id: 20260310-204724
- Postboot-check result: PASS

## Backup Command Output

```text
backup created: 20260310-204724
path: /Users/huangzhenfeng/WorkSpace/openclaw-watchdog/backups/20260310-204724
```

## launchd Services

```text
1492	-15	ai.openclaw.gateway
697	0	ai.openclaw.console
691	0	ai.openclaw.watchdog
```

- gateway pid: 1492
- watchdog pid: 691
- console pid: 697

## Port Listeners

### Gateway :18789

```text
COMMAND  PID          USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    1492 huangzhenfeng   16u  IPv4 0xf42a5b889018f8e7      0t0  TCP 127.0.0.1:18789 (LISTEN)
node    1492 huangzhenfeng   17u  IPv6 0x2dded84439a59dc6      0t0  TCP [::1]:18789 (LISTEN)
```

### Console :18890

```text
COMMAND PID          USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    697 huangzhenfeng   12u  IPv4 0x7b342be0c531d9db      0t0  TCP 127.0.0.1:18890 (LISTEN)
```

## Watchdog Runtime State

```text
WATCHDOG_STATUS=stopped
WATCHDOG_LAST_LOOP_AT=2026-03-08T23:43:36+0800
WATCHDOG_LAST_HEALTH_CHECK_AT=2026-03-08T23:43:19+0800
WATCHDOG_LAST_HEALTH_RESULT=ok
WATCHDOG_LAST_RECOVERY_AT=
WATCHDOG_LAST_RECOVERY_MODE=
WATCHDOG_LAST_INCIDENT_AT=
WATCHDOG_LAST_ERROR_CODE=
WATCHDOG_RESTART_COUNT_WINDOW=0
WATCHDOG_COOLDOWN_UNTIL=
WATCHDOG_PID=68054
```

## Postboot-check Output

```text
postboot-check: timeout=30s interval=3s
postboot-check: PASS
== launchd ==
1492	-15	ai.openclaw.gateway
691	0	ai.openclaw.watchdog

== gateway port 18789 ==
COMMAND  PID          USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    1492 huangzhenfeng   16u  IPv4 0xf42a5b889018f8e7      0t0  TCP 127.0.0.1:18789 (LISTEN)
node    1492 huangzhenfeng   17u  IPv6 0x2dded84439a59dc6      0t0  TCP [::1]:18789 (LISTEN)

== watchdog log tail ==
2026-03-10T19:46:48+0800 [openclaw-log] 2026-03-10T19:46:48.446+08:00 [gateway] agent model: minimax-portal/MiniMax-M2.5-highspeed
2026-03-10T19:46:48+0800 [openclaw-log] 2026-03-10T19:46:48.447+08:00 [gateway] listening on ws://127.0.0.1:18789, ws://[::1]:18789 (PID 1492)
2026-03-10T19:46:48+0800 [openclaw-log] 2026-03-10T19:46:48.448+08:00 [gateway] log file: /tmp/openclaw/openclaw-2026-03-10.log
2026-03-10T19:46:48+0800 [openclaw-log] 2026-03-10T19:46:48.463+08:00 [browser/server] Browser control listening on http://127.0.0.1:18791/ (auth=token)
2026-03-10T19:46:48+0800 [openclaw-log] 2026-03-10T19:46:48.622+08:00 [hooks:loader] Registered hook: boot-md -> gateway:startup
2026-03-10T19:46:48+0800 [openclaw-log] 2026-03-10T19:46:48.626+08:00 [hooks:loader] Registered hook: bootstrap-extra-files -> agent:bootstrap
2026-03-10T19:46:48+0800 [openclaw-log] 2026-03-10T19:46:48.627+08:00 [hooks:loader] Registered hook: command-logger -> command
2026-03-10T19:46:48+0800 [openclaw-log] 2026-03-10T19:46:48.648+08:00 [hooks:loader] Registered hook: session-memory -> command:new, command:reset
2026-03-10T19:46:48+0800 [openclaw-log] 2026-03-10T19:46:48.649+08:00 [hooks] loaded 4 internal hook handlers
2026-03-10T19:46:50+0800 [watchdog] gateway restart succeeded via CLI
2026-03-10T19:46:51+0800 [openclaw-log] 2026-03-10T19:46:51.279+08:00 [telegram] [default] starting provider (@huangzhenfeng_bot)
2026-03-10T19:46:51+0800 [openclaw-log] 2026-03-10T19:46:51.291+08:00 [telegram] autoSelectFamily=true (default-node22)
2026-03-10T19:46:51+0800 [openclaw-log] 2026-03-10T19:46:51.294+08:00 [telegram] dnsResultOrder=ipv4first (default-node22)
2026-03-10T19:51:03+0800 [openclaw-log] 2026-03-10T19:51:03.289+08:00 [telegram] autoSelectFamily=false (config)
2026-03-10T20:01:20+0800 [openclaw-log] 2026-03-10T20:01:20.833+08:00 [browser/service] Browser control service ready (profiles=2)
2026-03-10T20:01:21+0800 [openclaw-log] 2026-03-10T20:01:21.580+08:00 [browser/chrome] 🦞 openclaw browser started (chrome) profile "openclaw" on 127.0.0.1:18800 (pid 6113)
2026-03-10T20:10:55+0800 [openclaw-log] 2026-03-10T20:10:55.061+08:00 [exec] elevated command date
2026-03-10T20:11:06+0800 [openclaw-log] 2026-03-10T20:11:06.752+08:00 [telegram] sendMessage ok chat=6402657757 message=61
2026-03-10T20:29:20+0800 [openclaw-log] 2026-03-10T20:29:20.145+08:00 [exec] elevated command which codex
2026-03-10T20:29:22+0800 [openclaw-log] 2026-03-10T20:29:22.898+08:00 [exec] elevated command ls /Users/huangzhenfeng/.openclaw/workspace/skills/

== gateway log tail ==
2026-03-10T19:46:48.445+08:00 [health-monitor] started (interval: 300s, startup-grace: 60s, channel-connect-grace: 120s)
2026-03-10T19:46:48.446+08:00 [gateway] agent model: minimax-portal/MiniMax-M2.5-highspeed
2026-03-10T19:46:48.447+08:00 [gateway] listening on ws://127.0.0.1:18789, ws://[::1]:18789 (PID 1492)
2026-03-10T19:46:48.448+08:00 [gateway] log file: /tmp/openclaw/openclaw-2026-03-10.log
2026-03-10T19:46:48.463+08:00 [browser/server] Browser control listening on http://127.0.0.1:18791/ (auth=token)
2026-03-10T19:46:48.622+08:00 [hooks:loader] Registered hook: boot-md -> gateway:startup
2026-03-10T19:46:48.626+08:00 [hooks:loader] Registered hook: bootstrap-extra-files -> agent:bootstrap
2026-03-10T19:46:48.627+08:00 [hooks:loader] Registered hook: command-logger -> command
2026-03-10T19:46:48.648+08:00 [hooks:loader] Registered hook: session-memory -> command:new, command:reset
2026-03-10T19:46:48.649+08:00 [hooks] loaded 4 internal hook handlers
2026-03-10T19:46:51.279+08:00 [telegram] [default] starting provider (@huangzhenfeng_bot)
2026-03-10T19:46:51.291+08:00 [telegram] autoSelectFamily=true (default-node22)
2026-03-10T19:46:51.294+08:00 [telegram] dnsResultOrder=ipv4first (default-node22)
2026-03-10T19:51:03.289+08:00 [telegram] autoSelectFamily=false (config)
2026-03-10T20:01:20.833+08:00 [browser/service] Browser control service ready (profiles=2)
2026-03-10T20:01:21.580+08:00 [browser/chrome] 🦞 openclaw browser started (chrome) profile "openclaw" on 127.0.0.1:18800 (pid 6113)
2026-03-10T20:10:55.061+08:00 [exec] elevated command date
2026-03-10T20:11:06.752+08:00 [telegram] sendMessage ok chat=6402657757 message=61
2026-03-10T20:29:20.145+08:00 [exec] elevated command which codex
2026-03-10T20:29:22.898+08:00 [exec] elevated command ls /Users/huangzhenfeng/.openclaw/workspace/skills/

== error logs tail ==
-- watchdog.err.log --
2026-03-08T22:08:50+0800 [watchdog][error] too many restarts within 60s; cooldown 300s
-- gateway.err.log --
2026-03-08T23:03:43.672+08:00 [security] blocked URL fetch (url-fetch) target=https://clawhub.com/ reason=Blocked: resolves to private/internal/special-use IP address
2026-03-08T23:03:43.678+08:00 [tools] web_fetch failed: Blocked: resolves to private/internal/special-use IP address
2026-03-10T19:46:43.936+08:00 [openclaw] Unhandled promise rejection: AssertionError [ERR_ASSERTION]: Reached illegal state! IPv4 address changed from undefined to defined!
    at MDNSServer.handleUpdatedNetworkInterfaces (/Users/huangzhenfeng/openclaw/node_modules/.pnpm/@homebridge+ciao@1.3.5/node_modules/@homebridge/ciao/src/MDNSServer.ts:691:18)
    at NetworkManager.emit (node:events:520:22)
    at NetworkManager.checkForNewInterfaces (/Users/huangzhenfeng/openclaw/node_modules/.pnpm/@homebridge+ciao@1.3.5/node_modules/@homebridge/ciao/src/NetworkManager.ts:345:12)
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
2026-03-10T19:51:03.293+08:00 [telegram] fetch fallback: forcing autoSelectFamily=false + dnsResultOrder=ipv4first
2026-03-10T20:00:39.510+08:00 [telegram] fetch fallback: forcing autoSelectFamily=false + dnsResultOrder=ipv4first
2026-03-10T20:01:00.512+08:00 [telegram] fetch fallback: forcing autoSelectFamily=false + dnsResultOrder=ipv4first
```

## Console API Meta

```json
{
  "ok": true,
  "ts": "2026-03-10T12:47:26.992Z",
  "requestId": "req_a0aa328801d7",
  "error": null,
  "data": {
    "appName": "OpenClaw Console",
    "consoleVersion": "v1",
    "alertEnabled": false,
    "tokenConfigured": true,
    "tokenFingerprint": "c26dc3...4311",
    "agentId": "main",
    "gatewayPort": 18789,
    "consolePort": 18890,
    "consoleUrl": "http://127.0.0.1:18890",
    "gatewayLabel": "ai.openclaw.gateway",
    "watchdogLabel": "ai.openclaw.watchdog",
    "consoleLabel": "ai.openclaw.console"
  }
}
```

## Console API Status

```json
{
  "ok": true,
  "ts": "2026-03-10T12:47:26.983Z",
  "requestId": "req_69f2140ed7b9",
  "error": null,
  "data": {
    "overall": {
      "status": "healthy",
      "summary": "OpenClaw 在线，监控狗活跃中，目前无需进行任何恢复操作。",
      "updatedAt": "2026-03-10T12:47:26.983Z"
    },
    "gateway": {
      "status": "online",
      "pid": 1492,
      "port": 18789,
      "health": "ok",
      "lastHealthCheckAt": "2026-03-08T23:43:19+0800"
    },
    "watchdog": {
      "status": "running",
      "pid": 691,
      "lock": "held",
      "lastLoopAt": "2026-03-08T23:43:36+0800",
      "lastHealthResult": "ok"
    },
    "recovery": {
      "state": "stopped",
      "restartCountWindow": 0,
      "cooldownUntil": null,
      "lastRecoveryMode": null,
      "lastRecoveryAt": null,
      "lastErrorCode": null
    },
    "incident": {
      "hasRecentIncident": true,
      "detectedAt": "2026-03-10T19:46:45+0800",
      "reason": "OpenClaw 网关接收到关闭信号并正在退出。",
      "recoveryAction": "网关已恢复至在线状态。",
      "resolvedAt": "2026-03-10T19:46:48+0800",
      "outcome": "recovered"
    },
    "actionability": {
      "canRestartGateway": true,
      "canRunPostbootCheck": true,
      "canCreateBackup": true,
      "canTestChat": true,
      "canRollback": true,
      "reasonIfBlocked": null
    }
  }
}
```
