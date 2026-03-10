const state = {
  activeTab: "overview",
  logSource: "gateway",
  logsPaused: false,
  actionBusy: false,
  selectedRepoRoot: "",
  currentStatus: null,
  history: { summary: null, items: [] },
};

const el = {
  skeleton: document.querySelector("#skeleton"),
  attachView: document.querySelector("#attachView"),
  dashboard: document.querySelector("#dashboard"),
  errorState: document.querySelector("#errorState"),
  errorText: document.querySelector("#errorText"),
  retryBtn: document.querySelector("#retryBtn"),
  viewLogsBtn: document.querySelector("#viewLogsBtn"),
  checkUpdatesBtn: document.querySelector("#checkUpdatesBtn"),
  historyBtn: document.querySelector("#historyBtn"),

  repoPathInput: document.querySelector("#repoPathInput"),
  browseRepoBtn: document.querySelector("#browseRepoBtn"),
  attachRepoBtn: document.querySelector("#attachRepoBtn"),
  attachMessage: document.querySelector("#attachMessage"),

  tabs: Array.from(document.querySelectorAll(".tab")),
  panels: Array.from(document.querySelectorAll(".tab-panel")),

  globalState: document.querySelector("#globalState"),
  stateSummary: document.querySelector("#stateSummary"),
  targetPath: document.querySelector("#targetPath"),
  changeRepoBtn: document.querySelector("#changeRepoBtn"),

  processState: document.querySelector("#processState"),
  processMeta: document.querySelector("#processMeta"),
  portState: document.querySelector("#portState"),
  portMeta: document.querySelector("#portMeta"),
  healthState: document.querySelector("#healthState"),
  healthMeta: document.querySelector("#healthMeta"),
  autoRecoveryToggle: document.querySelector("#autoRecoveryToggle"),
  recoveryState: document.querySelector("#recoveryState"),
  recoveryMeta: document.querySelector("#recoveryMeta"),

  gitBranch: document.querySelector("#gitBranch"),
  gitDirty: document.querySelector("#gitDirty"),
  gitAhead: document.querySelector("#gitAhead"),
  gitHead: document.querySelector("#gitHead"),
  gitRecentList: document.querySelector("#gitRecentList"),
  openFinderBtn: document.querySelector("#openFinderBtn"),
  openTerminalBtn: document.querySelector("#openTerminalBtn"),

  incidentReason: document.querySelector("#incidentReason"),
  incidentAction: document.querySelector("#incidentAction"),
  incidentResult: document.querySelector("#incidentResult"),
  incidentRate: document.querySelector("#incidentRate"),
  incidentMeta: document.querySelector("#incidentMeta"),
  openHistoryBtn: document.querySelector("#openHistoryBtn"),

  sourceBtns: Array.from(document.querySelectorAll(".source-btn")),
  pauseLogsBtn: document.querySelector("#pauseLogsBtn"),
  openLogsBtn: document.querySelector("#openLogsBtn"),
  logsOutput: document.querySelector("#logsOutput"),

  actionButtons: Array.from(document.querySelectorAll(".action-btn")),
  actionResult: document.querySelector("#actionResult"),

  historyDrawer: document.querySelector("#historyDrawer"),
  closeHistoryBtn: document.querySelector("#closeHistoryBtn"),
  closeHistoryBackdrop: document.querySelector("#closeHistoryBackdrop"),
  historySummary: document.querySelector("#historySummary"),
  historyList: document.querySelector("#historyList"),
};

function setView(mode) {
  el.skeleton.classList.add("hidden");
  el.attachView.classList.add("hidden");
  el.dashboard.classList.add("hidden");
  el.errorState.classList.add("hidden");

  if (mode === "attach") {
    el.attachView.classList.remove("hidden");
    return;
  }
  if (mode === "dashboard") {
    el.dashboard.classList.remove("hidden");
    return;
  }
  if (mode === "error") {
    el.errorState.classList.remove("hidden");
    return;
  }
  el.skeleton.classList.remove("hidden");
}

function activateTab(tabId) {
  state.activeTab = tabId;
  el.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabId));
  el.panels.forEach((panel) => panel.classList.toggle("hidden", panel.dataset.panel !== tabId));
}

function setActionBusy(flag) {
  state.actionBusy = flag;
  el.actionButtons.forEach((button) => {
    button.disabled = flag;
  });
  el.attachRepoBtn.disabled = flag || !state.selectedRepoRoot;
  el.browseRepoBtn.disabled = flag;
  el.changeRepoBtn.disabled = flag;
  el.autoRecoveryToggle.disabled = flag;
}

function title(value) {
  if (!value) {
    return "未知";
  }
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function safeText(value, fallback = "-") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function summarizeState(status) {
  if (!status) {
    return {
      state: "offline",
      summary: "暂无监督器数据。",
    };
  }

  const age = Date.now() - Date.parse(status.ts || "");
  if (Number.isNaN(age) || age > 10000) {
    return {
      state: "offline",
      summary: "监督器数据已过期，OpenClaw 可能不可用或监督器无响应。",
    };
  }

  if (status.overall === "healthy") {
    return {
      state: "healthy",
      summary: "进程、端口和网关健康检查均正常。",
    };
  }
  if (status.overall === "degraded") {
    return {
      state: "degraded",
      summary: "OpenClaw 部分可用，请分别检查进程、端口和健康状态。",
    };
  }
  return {
    state: "offline",
    summary: "已连接的 OpenClaw 运行时离线或未连接。",
  };
}

function renderGit(status) {
  const git = status?.git || {};
  el.gitBranch.textContent = safeText(git.branch, git.available ? "detached" : "非 Git 仓库");
  el.gitDirty.textContent = git.available ? (git.dirty ? `${git.dirtyCount} 个文件变更` : "干净") : "不可用";
  el.gitAhead.textContent = git.available ? `领先 ${git.ahead || 0} / 落后 ${git.behind || 0}` : "不可用";
  el.gitHead.textContent = git.recentCommit ? `${git.recentCommit.shortHash} · ${git.recentCommit.subject}` : "不可用";

  el.gitRecentList.innerHTML = "";
  const commits = git.recentCommits || [];
  if (!commits.length) {
    const item = document.createElement("li");
    item.innerHTML = `<p class="commit-title">暂无最近提交数据</p><p class="commit-meta">连接 Git 管理的 OpenClaw 仓库后将显示此面板。</p>`;
    el.gitRecentList.appendChild(item);
    return;
  }

  commits.forEach((commit) => {
    const item = document.createElement("li");
    item.innerHTML = `
      <p class="commit-title">${safeText(commit.subject, "未知提交")}</p>
      <p class="commit-meta">${safeText(commit.shortHash)} · ${safeText(commit.date)}</p>
    `;
    el.gitRecentList.appendChild(item);
  });
}

function renderIncident(status) {
  const incident = status?.incident || {};
  el.incidentReason.textContent = safeText(incident.lastReason, "暂无事件记录。");
  el.incidentAction.textContent = safeText(incident.lastAction);
  el.incidentResult.textContent = safeText(incident.lastResult);
  el.incidentRate.textContent = incident.successRate === null ? "-" : `${incident.successRate}%`;
  el.incidentMeta.textContent = incident.lastAt
    ? `最近一次记录时间：${new Date(incident.lastAt).toLocaleString()}`
    : "事件记忆由 Guardian supervisor 保存，不写入目标仓库。";
}

function renderOverview(status) {
  const summary = summarizeState(status);
  const portListeners = status?.port?.listeners || [];
  state.selectedRepoRoot = status?.targetInfo?.repoRoot || state.selectedRepoRoot;

  el.globalState.textContent = title(summary.state);
  el.globalState.dataset.state = summary.state;
  el.stateSummary.textContent = summary.summary;
  el.targetPath.textContent = safeText(status?.targetInfo?.repoRoot, "未连接目标");

  el.processState.textContent = title(status?.service?.loaded ? "running" : status?.service?.state || "inactive");
  el.processMeta.textContent = status?.service?.pid
    ? `PID ${status.service.pid} · ${safeText(status.service.state)}`
    : `服务状态：${safeText(status?.service?.state, "inactive")}`;

  el.portState.textContent = status?.port?.listening ? `:${safeText(status.port.port)}` : "无监听";
  el.portMeta.textContent = portListeners.length
    ? `${portListeners.length} 个监听 · ${safeText(status.port.status)}`
    : `端口状态：${safeText(status?.port?.status, "unknown")}`;

  el.healthState.textContent = title(status?.health?.state || "unknown");
  el.healthMeta.textContent = status?.health?.lastCheckedAt
    ? `${safeText(status.health.output, "无输出")} · ${new Date(status.health.lastCheckedAt).toLocaleTimeString()}`
    : safeText(status?.health?.output, "暂无健康检查");

  el.autoRecoveryToggle.checked = Boolean(status?.recovery?.enabled);
  el.recoveryState.textContent = title(status?.recovery?.state || "disabled");
  el.recoveryMeta.textContent = status?.recovery?.lastAt
    ? `${safeText(status.recovery.lastAction)} · ${safeText(status.recovery.lastResult)} · ${new Date(status.recovery.lastAt).toLocaleTimeString()}`
    : "Supervisor 恢复默认关闭，需手动开启。";

  renderGit(status);
  renderIncident(status);
}

function renderHistory(payload) {
  state.history = payload;
  const items = payload?.items || [];
  const summary = payload?.summary || null;

  el.historySummary.textContent = summary?.successRate === null || summary?.successRate === undefined
    ? "暂无恢复事件。首次诊断或恢复后将显示历史。"
    : `最近结果：${safeText(summary.lastResult)} · 成功率：${summary.successRate}%${summary.repeatedSignature ? " · 检测到重复崩溃签名" : ""}`;

  el.historyList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "history-item";
    empty.innerHTML = `<p class="history-title">暂无事件记录。</p><p class="history-meta">请先连接目标并运行诊断，或等待首次监督器事件。</p>`;
    el.historyList.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const node = document.createElement("div");
    node.className = "history-item";
    node.innerHTML = `
      <p class="history-title">${safeText(item.trigger)}${item.repairAction ? ` · ${safeText(item.repairAction)}` : ""}</p>
      <p class="history-meta">${new Date(item.ts).toLocaleString()} · ${safeText(item.result)} · ${safeText(item.crashSignature)}</p>
      <p class="history-meta">${item.doctorSummary?.length ? item.doctorSummary.slice(0, 2).join(" | ") : "暂无体检摘要。"}</p>
    `;
    el.historyList.appendChild(node);
  });
}

async function refreshStatus() {
  const payload = await window.desktop.getStatus();
  if (!payload?.ok || !payload.status) {
    throw new Error(payload?.error?.message || "状态不可用");
  }
  state.currentStatus = payload.status;
  renderOverview(payload.status);
  return payload.status;
}

async function refreshHistory() {
  const payload = await window.desktop.getHistory();
  if (!payload?.ok) {
    throw new Error(payload?.error?.message || "历史不可用");
  }
  renderHistory(payload);
}

async function refreshLogs() {
  if (state.logsPaused) {
    return;
  }
  const payload = await window.desktop.getLogs(state.logSource, 200);
  if (!payload?.ok) {
    el.logsOutput.textContent = `日志加载失败：${payload?.error?.message || "未知错误"}`;
    return;
  }
  const lines = payload.lines || [];
  const text = lines
    .map((line) => {
      const prefix = line.time ? `[${new Date(line.time).toLocaleTimeString()}] ` : "";
      return `${prefix}${safeText(line.text, "")}`;
    })
    .join("\n");
  el.logsOutput.textContent = text || "暂无日志。";
  el.logsOutput.scrollTop = el.logsOutput.scrollHeight;
}

async function enterAttachMode(message = "当前尚未连接仓库。") {
  el.attachMessage.textContent = message;
  el.repoPathInput.value = state.selectedRepoRoot;
  setView("attach");
}

async function openHistoryDrawer() {
  try {
    await refreshHistory();
    el.historyDrawer.classList.remove("hidden");
  } catch (error) {
    el.actionResult.textContent = `历史加载失败：${error.message}`;
  }
}

function closeHistoryDrawer() {
  el.historyDrawer.classList.add("hidden");
}

async function attachRepo(repoRoot) {
  setActionBusy(true);
  el.attachMessage.textContent = "正在校验仓库并更新监督器目标...";
  try {
    state.selectedRepoRoot = repoRoot;
    const payload = await window.desktop.attachTarget(repoRoot);
    if (!payload?.ok || !payload.status) {
      throw new Error(payload?.error?.message || "连接失败");
    }
    state.currentStatus = payload.status;
    renderOverview(payload.status);
    setView("dashboard");
    await refreshHistory();
  } catch (error) {
    el.attachMessage.textContent = error.message;
  } finally {
    setActionBusy(false);
  }
}

async function chooseRepoAndMaybeAttach(autoAttach = false) {
  const payload = await window.desktop.chooseTarget();
  if (!payload?.ok) {
    throw new Error(payload?.error?.message || "选择仓库失败");
  }
  if (!payload.repoRoot) {
    return;
  }
  state.selectedRepoRoot = payload.repoRoot;
  el.repoPathInput.value = payload.repoRoot;
  el.attachRepoBtn.disabled = false;
  el.attachMessage.textContent = "仓库已选择，可点击连接。";
  if (autoAttach) {
    await attachRepo(payload.repoRoot);
  }
}

async function runAction(name) {
  setActionBusy(true);
  el.actionResult.textContent = `${title(name)}执行中...`;
  try {
    const payload = await window.desktop.runAction(name);
    if (!payload?.ok) {
      throw new Error(payload?.error?.message || `${name} 执行失败`);
    }

    if (payload.status) {
      state.currentStatus = payload.status;
      renderOverview(payload.status);
    } else {
      await refreshStatus();
    }
    await refreshHistory();

    if (name === "doctor") {
      el.actionResult.textContent = payload.summary?.join("\n") || payload.text || "体检完成。";
      return;
    }
    if (name === "repair") {
      const steps = payload.steps || [];
      el.actionResult.textContent = [payload.summary || "修复完成。"]
        .concat(steps.map((step) => `${step.action}: ${step.status?.overall || step.stderr || step.stdout || "completed"}`))
        .join("\n");
      return;
    }
    if (name === "exportDiagnostics") {
      el.actionResult.textContent = payload.zipPath
        ? `诊断包已导出到：\n${payload.zipPath}`
        : `诊断包已导出到：\n${payload.folderPath}`;
      return;
    }

    el.actionResult.textContent = payload.stdout || payload.summary || `${title(name)}完成。`;
  } catch (error) {
    el.actionResult.textContent = `${title(name)}失败：${error.message}`;
  } finally {
    setActionBusy(false);
  }
}

async function bootstrap() {
  setView("skeleton");
  const payload = await window.desktop.bootstrapState();

  if (!payload?.ok && payload?.startupError) {
    el.errorText.textContent = payload.startupError;
    setView("error");
    return;
  }

  if (payload?.startupError) {
    el.errorText.textContent = payload.startupError;
    setView("error");
    return;
  }

  if (payload?.attachRequired) {
    state.selectedRepoRoot = payload?.status?.targetInfo?.repoRoot || state.selectedRepoRoot;
    el.repoPathInput.value = state.selectedRepoRoot;
    await enterAttachMode("请选择一个已有 OpenClaw 仓库进行连接。");
    return;
  }

  if (payload?.invalidTarget) {
    const detail = payload?.status?.diagnostics?.errors?.[0] || "已保存的目标已失效。";
    state.selectedRepoRoot = payload?.status?.targetInfo?.repoRoot || state.selectedRepoRoot;
    el.repoPathInput.value = state.selectedRepoRoot;
    await enterAttachMode(detail);
    return;
  }

  state.currentStatus = payload?.status || null;
  renderOverview(state.currentStatus);
  setView("dashboard");
  await refreshHistory().catch(() => undefined);
}

function startPolling() {
  setInterval(() => {
    refreshStatus().catch((error) => {
      el.stateSummary.textContent = `状态刷新失败：${error.message}`;
    });
  }, 2000);

  setInterval(() => {
    if (state.activeTab === "logs") {
      refreshLogs().catch(() => undefined);
    }
  }, 5000);
}

el.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activateTab(tab.dataset.tab);
    if (tab.dataset.tab === "logs") {
      refreshLogs().catch(() => undefined);
    }
  });
});

el.sourceBtns.forEach((button) => {
  button.addEventListener("click", () => {
    state.logSource = button.dataset.source;
    el.sourceBtns.forEach((item) => item.classList.toggle("active", item === button));
    refreshLogs().catch(() => undefined);
  });
});

el.pauseLogsBtn.addEventListener("click", () => {
  state.logsPaused = !state.logsPaused;
  el.pauseLogsBtn.textContent = state.logsPaused ? "继续" : "暂停";
  if (!state.logsPaused) {
    refreshLogs().catch(() => undefined);
  }
});

el.checkUpdatesBtn.addEventListener("click", () => window.desktop.checkUpdates());
el.viewLogsBtn.addEventListener("click", () => window.desktop.openLogs());
el.openLogsBtn.addEventListener("click", () => window.desktop.openLogs());
el.retryBtn.addEventListener("click", () => bootstrap().catch(() => undefined));

el.historyBtn.addEventListener("click", () => openHistoryDrawer());
el.openHistoryBtn.addEventListener("click", () => openHistoryDrawer());
el.closeHistoryBtn.addEventListener("click", closeHistoryDrawer);
el.closeHistoryBackdrop.addEventListener("click", closeHistoryDrawer);

el.browseRepoBtn.addEventListener("click", () => {
  chooseRepoAndMaybeAttach(false).catch((error) => {
    el.attachMessage.textContent = error.message;
  });
});

el.changeRepoBtn.addEventListener("click", () => {
  chooseRepoAndMaybeAttach(true).catch((error) => {
    el.actionResult.textContent = error.message;
  });
});

el.attachRepoBtn.addEventListener("click", () => {
  attachRepo(state.selectedRepoRoot).catch((error) => {
    el.attachMessage.textContent = error.message;
  });
});

el.autoRecoveryToggle.addEventListener("change", async () => {
  setActionBusy(true);
  try {
    const payload = await window.desktop.setAutoRecovery(el.autoRecoveryToggle.checked);
    if (!payload?.ok || !payload.status) {
      throw new Error(payload?.error?.message || "更新自动恢复失败");
    }
    state.currentStatus = payload.status;
    renderOverview(payload.status);
    await refreshHistory().catch(() => undefined);
  } catch (error) {
    el.autoRecoveryToggle.checked = !el.autoRecoveryToggle.checked;
    el.actionResult.textContent = `自动恢复更新失败：${error.message}`;
  } finally {
    setActionBusy(false);
  }
});

el.openFinderBtn.addEventListener("click", () => window.desktop.openRepoInFinder());
el.openTerminalBtn.addEventListener("click", () => window.desktop.openRepoInTerminal());

document.querySelectorAll(".action-btn").forEach((button) => {
  button.addEventListener("click", () => {
    runAction(button.dataset.action).catch((error) => {
      el.actionResult.textContent = error.message;
    });
  });
});

bootstrap().catch((error) => {
  el.errorText.textContent = error.message;
  setView("error");
});
startPolling();
