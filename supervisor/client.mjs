import net from "node:net";

import { getRuntimePaths } from "../shared/runtime.mjs";

export async function requestSupervisor(method, params = {}, options = {}) {
  const socketPath = options.socketPath || getRuntimePaths().socketPath;
  const timeoutMs = options.timeoutMs || 15000;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Supervisor request timed out: ${method}`));
    }, timeoutMs);

    let buffer = "";
    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ method, params })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index === -1) {
        return;
      }
      const line = buffer.slice(0, index);
      clearTimeout(timer);
      socket.end();
      try {
        const payload = JSON.parse(line);
        if (!payload.ok) {
          reject(new Error(payload.error || `Supervisor ${method} failed`));
          return;
        }
        resolve(payload.data);
      } catch (error) {
        reject(error);
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
