import { createServer } from "node:http";
import fs from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import {
  config,
  ensureRuntime,
  executeAction,
  getBackups,
  getEvents,
  getLogs,
  getMeta,
  getStatusModel,
  nowIso,
} from "./core/api.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, "web");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function makeRequestId() {
  return `req_${crypto.randomBytes(6).toString("hex")}`;
}

function sendJson(res, statusCode, requestId, ok, data = null, error = null) {
  res.writeHead(statusCode, {
    "Content-Type": MIME_TYPES[".json"],
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify(
      {
        ok,
        ts: nowIso(),
        requestId,
        error,
        data,
      },
      null,
      2,
    ),
  );
}

function sendNotFound(res, requestId) {
  sendJson(res, 404, requestId, false, null, {
    code: "NOT_FOUND",
    message: "Resource not found",
    details: {},
  });
}

function sendMethodNotAllowed(res, requestId) {
  sendJson(res, 405, requestId, false, null, {
    code: "METHOD_NOT_ALLOWED",
    message: "Method not allowed",
    details: {},
  });
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getStaticPath(urlPathname) {
  const safePath = urlPathname === "/" ? "/index.html" : urlPathname;
  const filePath = path.normalize(path.join(WEB_DIR, safePath));
  if (!filePath.startsWith(WEB_DIR)) {
    return null;
  }
  return filePath;
}

async function serveStatic(req, res, requestId) {
  const url = new URL(req.url, `http://${config.host}:${config.consolePort}`);
  const filePath = getStaticPath(url.pathname);
  if (!filePath) {
    sendNotFound(res, requestId);
    return;
  }

  try {
    await access(filePath, fs.constants.R_OK);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const contents = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(contents);
  } catch {
    sendNotFound(res, requestId);
  }
}

async function handleApi(req, res, requestId) {
  const url = new URL(req.url, `http://${config.host}:${config.consolePort}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, requestId, true, await getStatusModel());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 30), 100);
    sendJson(res, 200, requestId, true, { items: await getEvents(limit) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/backups") {
    sendJson(res, 200, requestId, true, await getBackups());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/meta") {
    sendJson(res, 200, requestId, true, await getMeta());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    const source = url.searchParams.get("source") || "gateway";
    const limit = Math.min(Number(url.searchParams.get("limit") || 200), 400);
    const result = await getLogs(source, limit);
    if (result.error) {
      sendJson(res, 400, requestId, false, null, result.error);
      return;
    }
    sendJson(res, 200, requestId, true, result);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/actions/")) {
    const action = url.pathname.replace("/api/actions/", "");
    const body = await readBody(req);
    const result = await executeAction(action, body);
    sendJson(
      res,
      result.ok ? 200 : result.status === "blocked" ? 400 : 500,
      requestId,
      result.ok,
      {
        action: result.action || action,
        actionId: result.actionId,
        status: result.status,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        summary: result.summary,
        result: result.result || null,
      },
      result.error,
    );
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    sendNotFound(res, requestId);
    return;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, requestId);
    return;
  }

  await serveStatic(req, res, requestId);
}

await ensureRuntime();

const server = createServer((req, res) => {
  const requestId = makeRequestId();
  handleApi(req, res, requestId).catch((error) => {
    sendJson(res, 500, requestId, false, null, {
      code: "INTERNAL_ERROR",
      message: error.message || "Unhandled server error",
      details: {},
    });
  });
});

server.listen(config.consolePort, config.host, () => {
  process.stdout.write(`${nowIso()} [console] listening on http://${config.host}:${config.consolePort}\n`);
});
