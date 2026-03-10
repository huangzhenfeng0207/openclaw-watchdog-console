const state = {
  bootstrap: null,
  activeTab: "overview",
  logSource: "gateway",
  logsPaused: false,
  actionBusy: false,
  healthyCandidateSince: null,
  currentStatus: null,
  model: "Unknown",
};

const el = {
  skeleton: document.querySelector("#skeleton"),
  dashboard: document.querySelector("#dashboard"),
  setupFlow: document.querySelector("#setupFlow"),
  errorState: document.querySelector("#errorState"),
  errorText: document.querySelector("#errorText"),
  retryBtn: document.querySelector("#retryBtn"),
  viewLogsBtn: document.querySelector("#viewLogsBtn"),
  checkUpdatesBtn: document.querySelector("#checkUpdatesBtn"),

  tokenInput: document.querySelector("#tokenInput"),
  saveTokenBtn: document.querySelector("#saveTokenBtn"),
  setupMessage: document.querySelector("#setupMessage"),

  tabs: Array.from(document.querySelectorAll(".tab")),
  panels: Array.from(document.querySelectorAll(".tab-panel")),

  globalState: document.querySelector("#globalState"),
  gatewayStatus: document.querySelector("#gatewayStatus"),
  watchdogStatus: document.querySelector("#watchdogStatus"),
  modelValue: document.querySelector("#modelValue"),
  portValue: document.querySelector("#portValue"),
  overviewHint: document.querySelector("#overviewHint"),

  sourceBtns: Array.from(document.querySelectorAll(".source-btn")),
  pauseLogsBtn: document.querySelector("#pauseLogsBtn"),
  logsOutput: document.querySelector("#logsOutput"),

  restartBtn: document.querySelector("#restartBtn"),
  chatInput: document.querySelector("#chatInput"),
  chatBtn: document.querySelector("#chatBtn"),
  actionResult: document.querySelector("#actionResult"),
};

function setView(mode) {
  el.skeleton.classList.add("hidden");
  el.dashboard.classList.add("hidden");
  el.setupFlow.classList.add("hidden");
  el.errorState.classList.add("hidden");

  if (mode === "dashboard") {
    el.dashboard.classList.remove("hidden");
  } else if (mode === "setup") {
    el.setupFlow.classList.remove("hidden");
  } else if (mode === "error") {
    el.errorState.classList.remove("hidden");
  } else {
    el.skeleton.classList.remove("hidden");
  }
}

function setActionBusy(flag) {
  state.actionBusy = flag;
  el.restartBtn.disabled = flag;
  el.chatBtn.disabled = flag;
  el.saveTokenBtn.disabled = flag;
}

function activateTab(tabId) {
  state.activeTab = tabId;
  el.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabId));
  el.panels.forEach((panel) => panel.classList.toggle("hidden", panel.dataset.panel !== tabId));
}

function mapState(raw) {
  if (!raw) {
    return "offline";
  }

  const now = Date.now();
  const updatedAtMs = Date.parse(raw.overall?.updatedAt || "");
  const stale = Number.isNaN(updatedAtMs) || now - updatedAtMs > 10000;
  if (stale) {
    state.healthyCandidateSince = null;
    return "offline";
  }

  const gatewayOk = raw.gateway?.status === "online";
  const watchdogOk = raw.watchdog?.status === "running";
  const healthyNow = gatewayOk && watchdogOk;

  if (!healthyNow) {
    state.healthyCandidateSince = null;
    return gatewayOk || watchdogOk ? "degraded" : "offline";
  }

  if (!state.healthyCandidateSince) {
    state.healthyCandidateSince = now;
    return "degraded";
  }

  if (now - state.healthyCandidateSince < 6000) {
    return "degraded";
  }

  return "healthy";
}

function label(value) {
  if (!value) {
    return "Unknown";
  }
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function renderOverview(status, model) {
  const globalState = mapState(status);

  el.globalState.textContent = label(globalState);
  el.globalState.dataset.state = globalState;

  el.gatewayStatus.textContent = label(status?.gateway?.status || "unknown");
  el.watchdogStatus.textContent = label(status?.watchdog?.status || "unknown");
  el.modelValue.textContent = model || "Unknown";
  el.portValue.textContent = status?.gateway?.port ? String(status.gateway.port) : "Unknown";

  el.overviewHint.textContent = `Polling every 2s. Last update: ${new Date().toLocaleTimeString()}`;
}

async function refreshStatus() {
  const payload = await window.desktop.getStatus();
  if (!payload?.ok || !payload.status) {
    throw new Error("Status unavailable");
  }
  state.currentStatus = payload.status;
  state.model = payload.model || state.model || "Unknown";
  renderOverview(state.currentStatus, state.model);
}

async function refreshLogs() {
  if (state.logsPaused) {
    return;
  }
  const payload = await window.desktop.getLogs(state.logSource, 200);
  if (payload?.error) {
    el.logsOutput.textContent = `Failed to load logs: ${payload.error}`;
    return;
  }

  const lines = payload?.lines || [];
  const text = lines.map((line) => line.text).join("\n");
  el.logsOutput.textContent = text || "No log lines.";
  el.logsOutput.scrollTop = el.logsOutput.scrollHeight;
}

async function runRestart() {
  setActionBusy(true);
  el.actionResult.textContent = "Restarting gateway and watchdog...";

  try {
    const payload = await window.desktop.restartAll();
    if (!payload?.ok) {
      throw new Error(payload?.error?.message || "Restart failed");
    }
    el.actionResult.textContent = "Runtime restart completed.";
    if (payload.status) {
      state.currentStatus = payload.status;
      renderOverview(state.currentStatus, state.model);
    }
  } catch (error) {
    el.actionResult.textContent = `Restart failed: ${error.message}`;
  } finally {
    setActionBusy(false);
  }
}

function fmtUsage(usage) {
  if (!usage) {
    return "n/a";
  }
  const input = usage.input ?? "-";
  const output = usage.output ?? "-";
  const total = usage.total ?? "-";
  return `input=${input}, output=${output}, total=${total}`;
}

async function runChat() {
  setActionBusy(true);
  el.actionResult.textContent = "Running test chat...";

  try {
    const payload = await window.desktop.testChat(el.chatInput.value || "Health check");
    if (!payload?.ok) {
      throw new Error(payload?.error?.message || "Test chat failed");
    }
    el.actionResult.textContent = [
      `Reply: ${payload.reply || "(empty)"}`,
      `Latency: ${payload.latencyMs ?? "n/a"} ms`,
      `Token Usage: ${fmtUsage(payload.usage)}`,
    ].join("\n");
  } catch (error) {
    el.actionResult.textContent = `Test chat failed: ${error.message}`;
  } finally {
    setActionBusy(false);
  }
}

async function saveToken() {
  const token = el.tokenInput.value.trim();
  if (!token) {
    el.setupMessage.textContent = "Token is required.";
    return;
  }

  setActionBusy(true);
  el.setupMessage.textContent = "Securing token and starting runtime...";

  try {
    const payload = await window.desktop.saveToken(token);
    if (!payload?.ok) {
      throw new Error(payload?.error?.message || "Token setup failed");
    }

    state.currentStatus = payload.status || null;
    state.model = payload.model || "Unknown";
    renderOverview(state.currentStatus, state.model);
    setView("dashboard");
  } catch (error) {
    el.setupMessage.textContent = error.message;
  } finally {
    setActionBusy(false);
  }
}

async function bootstrap() {
  setView("skeleton");

  const payload = await window.desktop.bootstrapState();
  state.bootstrap = payload;

  if (payload?.startupError) {
    el.errorText.textContent = payload.startupError;
    setView("error");
    return;
  }

  if (payload?.tokenMissing) {
    setView("setup");
    return;
  }

  state.currentStatus = payload?.status || null;
  state.model = payload?.model || "Unknown";
  renderOverview(state.currentStatus, state.model);
  setView("dashboard");
}

function bind() {
  el.tabs.forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));

  el.sourceBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      state.logSource = btn.dataset.source;
      el.sourceBtns.forEach((it) => it.classList.toggle("active", it === btn));
      refreshLogs();
    });
  });

  el.pauseLogsBtn.addEventListener("click", () => {
    state.logsPaused = !state.logsPaused;
    el.pauseLogsBtn.textContent = state.logsPaused ? "Resume" : "Pause";
    if (!state.logsPaused) {
      refreshLogs();
    }
  });

  el.restartBtn.addEventListener("click", runRestart);
  el.chatBtn.addEventListener("click", runChat);
  el.saveTokenBtn.addEventListener("click", saveToken);

  el.retryBtn.addEventListener("click", async () => {
    setView("skeleton");
    const payload = await window.desktop.retryStartup();
    if (!payload?.ok) {
      el.errorText.textContent = payload?.startupError || "Retry failed";
      setView("error");
      return;
    }
    await bootstrap();
  });

  el.viewLogsBtn.addEventListener("click", async () => {
    await window.desktop.openLogs();
  });

  el.checkUpdatesBtn.addEventListener("click", async () => {
    await window.desktop.checkUpdates();
  });
}

async function run() {
  bind();
  await bootstrap();
  activateTab("overview");

  setInterval(async () => {
    if (!document.hidden && !state.bootstrap?.tokenMissing) {
      try {
        await refreshStatus();
      } catch {
        el.errorText.textContent = "Status polling failed.";
        setView("error");
      }
    }
  }, 2000);

  setInterval(async () => {
    if (state.activeTab === "logs" && !document.hidden) {
      await refreshLogs();
    }
  }, 2000);
}

run();
