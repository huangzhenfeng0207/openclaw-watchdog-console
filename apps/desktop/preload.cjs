const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  bootstrapState: () => ipcRenderer.invoke("app:bootstrap"),
  getStatus: () => ipcRenderer.invoke("app:status"),
  getLogs: (source, limit) => ipcRenderer.invoke("logs:get", source, limit),
  restartAll: () => ipcRenderer.invoke("action:restart-all"),
  testChat: (message) => ipcRenderer.invoke("action:test-chat", message),
  saveToken: (token) => ipcRenderer.invoke("token:save", token),
  retryStartup: () => ipcRenderer.invoke("app:retry"),
  openLogs: () => ipcRenderer.invoke("app:open-logs"),
  checkUpdates: () => ipcRenderer.invoke("app:check-updates"),
});
