const state = {
  status: null,
  events: [],
  backups: [],
  meta: null,
  selectedLogSource: "gateway",
  logsExpanded: false,
  inFlight: {
    status: false,
    events: false,
    logs: false,
    backups: false,
    meta: false,
  },
};

const elements = {
  hero: document.querySelector("#hero"),
  overallStatus: document.querySelector("#overallStatus"),
  overallSummary: document.querySelector("#overallSummary"),
  overallUpdatedAt: document.querySelector("#overallUpdatedAt"),
  confidenceText: document.querySelector("#confidenceText"),
  gatewayPill: document.querySelector("#gatewayPill"),
  watchdogPill: document.querySelector("#watchdogPill"),
  recoveryPill: document.querySelector("#recoveryPill"),
  gatewayFacts: document.querySelector("#gatewayFacts"),
  watchdogFacts: document.querySelector("#watchdogFacts"),
  recoveryFacts: document.querySelector("#recoveryFacts"),
  incidentPanel: document.querySelector("#incidentPanel"),
  timelineList: document.querySelector("#timelineList"),
  metaFacts: document.querySelector("#metaFacts"),
  metaSummary: document.querySelector("#metaSummary"),
  actionHint: document.querySelector("#actionHint"),
  actionState: document.querySelector("#actionState"),
  chatMessage: document.querySelector("#chatMessage"),
  rollbackSelect: document.querySelector("#rollbackSelect"),
  logsShell: document.querySelector("#logsShell"),
  logsOutput: document.querySelector("#logsOutput"),
  toggleLogs: document.querySelector("#toggleLogs"),
  refreshLogs: document.querySelector("#refreshLogs"),
  logTabs: Array.from(document.querySelectorAll("[data-log-source]")),
  actionButtons: Array.from(document.querySelectorAll("[data-action]")),
};

function formatTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function labelize(value) {
  if (!value) {
    return "-";
  }
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message || "Request failed");
  }
  return payload.data;
}

function setHeroState(overallStatus) {
  const status = overallStatus?.status || "unknown";
  elements.hero.dataset.status = status;
  elements.overallStatus.textContent = labelize(status);
  elements.overallSummary.textContent = overallStatus?.summary || "暂无可用摘要。";
  elements.overallUpdatedAt.textContent = formatTime(overallStatus?.updatedAt);
  const confidenceMap = {
    healthy: "极佳",
    recovering: "警告",
    degraded: "降级",
    cooldown: "极低",
    offline: "离线",
    unknown: "未知",
  };
  elements.confidenceText.textContent = confidenceMap[status] || "未知";
}

function renderFacts(container, items) {
  container.innerHTML = items
    .map(
      (item) => `
        <div class="fact-row">
          <dt>${escapeHtml(item.label)}</dt>
          <dd>${escapeHtml(item.value)}</dd>
        </div>
      `,
    )
    .join("");
}

function setPill(element, value, tone) {
  element.textContent = labelize(value);
  element.dataset.tone = tone || "neutral";
}

function renderStatus() {
  const status = state.status;
  if (!status) {
    return;
  }

  setHeroState(status.overall);

  setPill(elements.gatewayPill, status.gateway.status, status.gateway.status === "online" ? "good" : "bad");
  renderFacts(elements.gatewayFacts, [
    { label: "健康检查", value: labelize(status.gateway.health) },
    { label: "最后检查", value: formatTime(status.gateway.lastHealthCheckAt) },
    { label: "端口", value: String(status.gateway.port || "-") },
    { label: "进程 ID", value: String(status.gateway.pid || "-") },
  ]);

  setPill(elements.watchdogPill, status.watchdog.status, status.watchdog.status === "running" ? "good" : "warn");
  renderFacts(elements.watchdogFacts, [
    { label: "主锁", value: labelize(status.watchdog.lock) },
    { label: "最后轮询", value: formatTime(status.watchdog.lastLoopAt) },
    { label: "进程 ID", value: String(status.watchdog.pid || "-") },
  ]);

  const recoveryToneMap = {
    idle: "good",
    recovering: "warn",
    cooldown: "bad",
    degraded: "bad",
    stopped: "neutral",
    unknown: "neutral",
  };
  setPill(elements.recoveryPill, status.recovery.state, recoveryToneMap[status.recovery.state] || "neutral");
  renderFacts(elements.recoveryFacts, [
    { label: "重启宽限期", value: String(status.recovery.restartCountWindow ?? "-") },
    { label: "上次恢复模式", value: labelize(status.recovery.lastRecoveryMode) },
    { label: "上次恢复时间", value: formatTime(status.recovery.lastRecoveryAt) },
    { label: "冷确期至", value: formatTime(status.recovery.cooldownUntil) },
    { label: "Last Error", value: labelize(status.recovery.lastErrorCode) },
  ]);

  renderIncident(status.incident);
  syncActionability(status.actionability);
}

function renderIncident(incident) {
  if (!incident?.hasRecentIncident) {
    elements.incidentPanel.innerHTML = `
      <div class="incident-empty">
        <strong>暂无近期异常</strong>
        <p>目前恢复轮询正常安静。</p>
      </div>
    `;
    return;
  }

  elements.incidentPanel.innerHTML = `
    <div class="incident-grid">
      <div>
        <span>检测时间</span>
        <strong>${escapeHtml(formatTime(incident.detectedAt))}</strong>
      </div>
      <div>
        <span>处理结果</span>
        <strong>${escapeHtml(labelize(incident.outcome))}</strong>
      </div>
      <div>
        <span>发生了什么</span>
        <strong>${escapeHtml(incident.reason || "-")}</strong>
      </div>
      <div>
        <span>恢复操作</span>
        <strong>${escapeHtml(incident.recoveryAction || "-")}</strong>
      </div>
      <div>
        <span>解决时间</span>
        <strong>${escapeHtml(formatTime(incident.resolvedAt))}</strong>
      </div>
    </div>
  `;
}

function renderEvents() {
  elements.timelineList.innerHTML = state.events.length
    ? state.events
        .map(
          (event) => `
            <li class="timeline-item">
              <div class="timeline-dot" data-level="${escapeHtml(event.level)}"></div>
              <div class="timeline-copy">
                <div class="timeline-head">
                  <strong>${escapeHtml(event.title)}</strong>
                  <span>${escapeHtml(formatTime(event.ts))}</span>
                </div>
                <p>${escapeHtml(event.message)}</p>
                <small>${escapeHtml(labelize(event.source))} / ${escapeHtml(labelize(event.category))}</small>
              </div>
            </li>
          `,
        )
        .join("")
    : `<li class="timeline-empty">暂无近期事件。</li>`;
}

function renderMeta() {
  if (!state.meta) {
    return;
  }
  elements.metaSummary.textContent = `Console ${state.meta.consoleVersion} • ${state.meta.consolePort}`;
  renderFacts(elements.metaFacts, [
    { label: "控制台端口", value: String(state.meta.consolePort) },
    { label: "网关端口", value: String(state.meta.gatewayPort) },
    { label: "代理节点", value: state.meta.agentId || "-" },
    { label: "报警配置", value: state.meta.alertEnabled ? "已开启" : "未开启" },
    { label: "网关令牌", value: state.meta.tokenConfigured ? state.meta.tokenFingerprint : "未配置" },
  ]);
}

function renderBackups() {
  const items = state.backups || [];
  elements.rollbackSelect.innerHTML = items.length
    ? items
        .map(
          (item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)} • ${escapeHtml(formatTime(item.createdAt))}</option>`,
        )
        .join("")
    : `<option value="">暂无快照</option>`;
}

function syncActionability(actionability) {
  const blockedReason = actionability?.reasonIfBlocked || "";
  elements.actionHint.textContent = blockedReason || "Actions are available. Recovery remains owned by watchdog.";
  for (const button of elements.actionButtons) {
    const action = button.dataset.action;
    let disabled = false;
    let title = "";
    if (action === "test-chat" && !actionability?.canTestChat) {
      disabled = true;
      title = blockedReason || "测试对话当前不可用。";
    }
    if (action === "rollback" && !actionability?.canRollback) {
      disabled = true;
      title = "当前无可用快照供回滚。";
    }
    button.disabled = disabled;
    button.title = title;
  }
}

async function loadStatus(force = false) {
  if (state.inFlight.status && !force) {
    return;
  }
  state.inFlight.status = true;
  try {
    state.status = await api("/api/status");
    renderStatus();
  } catch (error) {
    elements.actionState.textContent = `状态刷新失败: ${error.message}`;
  } finally {
    state.inFlight.status = false;
  }
}

async function loadEvents(force = false) {
  if (state.inFlight.events && !force) {
    return;
  }
  state.inFlight.events = true;
  try {
    const data = await api("/api/events?limit=30");
    state.events = data.items || [];
    renderEvents();
  } catch (error) {
    elements.actionState.textContent = `事件刷新失败: ${error.message}`;
  } finally {
    state.inFlight.events = false;
  }
}

async function loadBackups(force = false) {
  if (state.inFlight.backups && !force) {
    return;
  }
  state.inFlight.backups = true;
  try {
    const data = await api("/api/backups");
    state.backups = data.items || [];
    renderBackups();
  } catch (error) {
    elements.actionState.textContent = `备份刷新失败: ${error.message}`;
  } finally {
    state.inFlight.backups = false;
  }
}

async function loadMeta(force = false) {
  if (state.inFlight.meta && !force) {
    return;
  }
  state.inFlight.meta = true;
  try {
    state.meta = await api("/api/meta");
    renderMeta();
  } catch (error) {
    elements.actionState.textContent = `配置摘要刷新失败: ${error.message}`;
  } finally {
    state.inFlight.meta = false;
  }
}

async function loadLogs(force = false) {
  if (!state.logsExpanded) {
    return;
  }
  if (state.inFlight.logs && !force) {
    return;
  }
  state.inFlight.logs = true;
  try {
    const data = await api(`/api/logs?source=${encodeURIComponent(state.selectedLogSource)}&limit=120`);
    elements.logsOutput.textContent = data.lines?.map((line) => line.text).join("\n") || "无日志。";
  } catch (error) {
    elements.logsOutput.textContent = `日志刷新失败: ${error.message}`;
  } finally {
    state.inFlight.logs = false;
  }
}

async function runAction(action) {
  const button = elements.actionButtons.find((item) => item.dataset.action === action);
  if (button) {
    button.disabled = true;
    button.dataset.running = "true";
  }

  let payload = {};
  if (action === "test-chat") {
    payload = { message: elements.chatMessage.value.trim() || "watchdog在线吗" };
  }
  if (action === "rollback") {
    const snapshotId = elements.rollbackSelect.value;
    if (!snapshotId) {
      elements.actionState.textContent = "回滚被拒绝：请先选择一个快照后再执行回滚。";
      if (button) {
        button.disabled = false;
        button.dataset.running = "false";
      }
      return;
    }
    payload = { snapshotId };
  }
  if (action === "postboot-check") {
    payload = { timeoutSeconds: 45 };
  }

  elements.actionState.textContent = `正在运行 ${labelize(action)}...`;

  try {
    const data = await api(`/api/actions/${action}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const reply = data.result?.parsed?.reply;
    elements.actionState.textContent = reply ? `${data.summary} Reply: ${reply}` : `${data.summary}`;
    await loadStatus(true);
    await loadEvents(true);
    await loadBackups(true);
    await loadLogs(true);
  } catch (error) {
    elements.actionState.textContent = `${labelize(action)} 失败: ${error.message}`;
  } finally {
    if (button) {
      button.dataset.running = "false";
      renderStatus();
    }
  }
}

function bindEvents() {
  elements.actionButtons.forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.action));
  });

  elements.logTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedLogSource = button.dataset.logSource;
      elements.logTabs.forEach((item) => item.classList.toggle("is-active", item === button));
      loadLogs(true);
    });
  });

  elements.toggleLogs.addEventListener("click", () => {
    state.logsExpanded = !state.logsExpanded;
    elements.logsShell.classList.toggle("is-collapsed", !state.logsExpanded);
    elements.toggleLogs.textContent = state.logsExpanded ? "折叠日志" : "展开日志";
    if (state.logsExpanded) {
      loadLogs(true);
    }
  });

  elements.refreshLogs.addEventListener("click", () => {
    loadLogs(true);
  });
}

async function boot() {
  bindEvents();
  await Promise.all([loadStatus(true), loadEvents(true), loadBackups(true), loadMeta(true)]);
  setInterval(() => loadStatus(false), 3000);
  setInterval(() => loadEvents(false), 5000);
  setInterval(() => loadLogs(false), 10000);
}

boot();
