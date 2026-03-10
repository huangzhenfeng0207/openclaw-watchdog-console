const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  bootstrapState: () => ipcRenderer.invoke("app:bootstrap"),
  getStatus: () => ipcRenderer.invoke("app:status"),
  getHistory: () => ipcRenderer.invoke("app:history"),
  chooseTarget: () => ipcRenderer.invoke("app:choose-target"),
  attachTarget: (repoRoot) => ipcRenderer.invoke("app:attach-target", repoRoot),
  setAutoRecovery: (enabled) => ipcRenderer.invoke("app:set-auto-recovery", enabled),
  getLogs: (source, limit) => ipcRenderer.invoke("logs:get", source, limit),
  runAction: (name) => ipcRenderer.invoke("action:run", name),
  openLogs: () => ipcRenderer.invoke("app:open-logs"),
  checkUpdates: () => ipcRenderer.invoke("app:check-updates"),
  openRepoInFinder: () => ipcRenderer.invoke("repo:open-finder"),
  openRepoInTerminal: () => ipcRenderer.invoke("repo:open-terminal"),
});
