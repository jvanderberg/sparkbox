/**
 * Sparkbox host process. Serves the built app, the preview host on a second
 * port (a second origin), mints invite tokens, proxies the free agent to
 * OpenRouter with a server-side key, and relays WISP for sandbox networking.
 * It stores nothing: tokens are signed, counters live in memory.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
import { DailyCounter, mintToken, verifyToken } from "./tokens.ts";
import { defaultAllowlist, serveWisp } from "./wisp.ts";

const env = process.env;
const appPort = Number(env.PORT ?? 8080);
const previewPort = Number(env.SPARKBOX_PREVIEW_PORT ?? 8081);
const distDir = env.SPARKBOX_DIST ?? join(process.cwd(), "dist");
const secret = env.SPARKBOX_TOKEN_SECRET ?? "";
const inviteCodes = (env.SPARKBOX_INVITE_CODES ?? "")
  .split(",")
  .map((code) => code.trim())
  .filter(Boolean);
const openRouterKey = env.SPARKBOX_OPENROUTER_KEY ?? "";
const freeModel = env.SPARKBOX_FREE_MODEL ?? "anthropic/claude-haiku-5.5";
const freeLabel = env.SPARKBOX_FREE_LABEL ?? "Sparkbox";
const publicOrigin = env.SPARKBOX_PUBLIC_ORIGIN ?? ""; // e.g. https://sparkbox.fly.dev
const previewOrigin = env.SPARKBOX_PREVIEW_ORIGIN ?? (publicOrigin ? `${publicOrigin}:8443` : "");
const limits = {
  requestsPerTokenPerDay: Number(env.SPARKBOX_REQUESTS_PER_DAY ?? 400),
  requestsGlobalPerDay: Number(env.SPARKBOX_GLOBAL_REQUESTS_PER_DAY ?? 5000),
  relayBytesPerTokenPerDay: Number(env.SPARKBOX_RELAY_BYTES_PER_DAY ?? 2 * 1024 ** 3),
  maxTokens: Number(env.SPARKBOX_MAX_OUTPUT_TOKENS ?? 16_000),
};
const allowlist = (env.SPARKBOX_RELAY_ALLOWLIST ?? defaultAllowlist.join(","))
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const freeAgentEnabled = Boolean(secret && openRouterKey && inviteCodes.length);
if (!secret)
  console.warn("SPARKBOX_TOKEN_SECRET is not set; invite tokens and the relay are disabled.");

const requests = new DailyCounter();
const relayBytes = new DailyCounter();

const isolation: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
};
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function log(message: string) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...isolation });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage, limit = 2 * 1024 * 1024) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function serveFile(
  response: ServerResponse,
  path: string,
  extraHeaders: Record<string, string> = {},
) {
  const type = types[extname(path).toLowerCase()] ?? "application/octet-stream";
  const immutable = /\/assets\//.test(path);
  response.writeHead(200, {
    "content-type": type,
    "content-length": statSync(path).size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...isolation,
    ...extraHeaders,
  });
  createReadStream(path).pipe(response);
}

function staticPath(url: string) {
  const clean = decodeURIComponent((url.split("?")[0] ?? "/").split("#")[0] ?? "/");
  const target = normalize(join(distDir, clean));
  if (!target.startsWith(distDir)) return null;
  if (existsSync(target) && statSync(target).isFile()) return target;
  return null;
}

function bearer(request: IncomingMessage) {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (url.pathname === "/config.json") {
    return sendJson(response, 200, {
      previewOrigin,
      wispUrl: secret ? `${publicOrigin.replace(/^http/, "ws")}/wisp/` : "",
      freeAgent: freeAgentEnabled ? { label: freeLabel, model: freeModel } : null,
    });
  }
  if (url.pathname === "/api/invite" && request.method === "POST") {
    if (!secret || !inviteCodes.length)
      return sendJson(response, 503, { error: "Invites are not enabled." });
    let body: { code?: string } = {};
    try {
      body = JSON.parse((await readBody(request, 4096)).toString("utf8") || "{}");
    } catch {
      return sendJson(response, 400, { error: "Send JSON with a code." });
    }
    const code = String(body.code ?? "").trim();
    const ip = String(request.headers["fly-client-ip"] ?? request.socket.remoteAddress ?? "?");
    if (requests.add(`invite:${ip}`) > 30)
      return sendJson(response, 429, { error: "Too many attempts today." });
    if (!inviteCodes.includes(code))
      return sendJson(response, 403, { error: "That invite code is not valid." });
    log(`invite accepted from ${ip}`);
    return sendJson(response, 200, { token: mintToken(secret) });
  }
  if (url.pathname === "/api/agent/chat/completions" && request.method === "POST") {
    if (!freeAgentEnabled)
      return sendJson(response, 503, { error: "The free agent is not enabled." });
    const session = verifyToken(secret, bearer(request));
    if (!session) return sendJson(response, 401, { error: "Enter a valid invite code first." });
    if (requests.add(`token:${session.id}`) > limits.requestsPerTokenPerDay)
      return sendJson(response, 429, {
        error: "Daily limit reached for the free agent. Try again tomorrow or add your own key.",
      });
    if (requests.add("global") > limits.requestsGlobalPerDay)
      return sendJson(response, 429, {
        error: "The free agent is busy today. Add your own key to continue.",
      });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(request)).toString("utf8"));
    } catch {
      return sendJson(response, 400, { error: "Invalid request body." });
    }
    body.model = freeModel;
    if (typeof body.max_tokens !== "number" || body.max_tokens > limits.maxTokens)
      body.max_tokens = limits.maxTokens;
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${openRouterKey}`,
        "content-type": "application/json",
        "HTTP-Referer": publicOrigin || "https://sparkbox.local",
        "X-Title": "Sparkbox",
      },
      body: JSON.stringify(body),
    });
    const headers: Record<string, string> = { ...isolation };
    for (const name of ["content-type", "cache-control", "x-request-id"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    response.writeHead(upstream.status, headers);
    if (!upstream.body) return response.end();
    const reader = upstream.body.getReader();
    request.on("close", () => void reader.cancel().catch(() => {}));
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(value);
      }
    } finally {
      response.end();
    }
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

const app = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/") || url.pathname === "/config.json") {
    void handleApi(request, response, url).catch((error) => {
      log(`api error ${url.pathname}: ${error instanceof Error ? error.message : error}`);
      if (!response.headersSent) sendJson(response, 500, { error: "Server error." });
      else response.end();
    });
    return;
  }
  if (url.pathname === "/healthz") return sendJson(response, 200, { ok: true });
  const file = staticPath(url.pathname) ?? join(distDir, "index.html");
  serveFile(response, file);
});

// The preview host: only the Wasmer service worker and its control document.
const preview = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const allowed = ["/wasmer-service-worker.js", "/.wasmer/host.html", "/.wasmer/host.js"];
  if (!allowed.includes(url.pathname)) {
    response.writeHead(404, { "content-type": "text/plain", ...isolation });
    response.end("Preview is not running. Start it from Sparkbox.");
    return;
  }
  serveFile(response, join(distDir, url.pathname), { "service-worker-allowed": "/" });
});

const relay = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
app.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  // The WISP client requires an endpoint ending in "/", so the token travels
  // in the path: /wisp/<token>/ (a query string is accepted too).
  const match = /^\/wisp(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!match || !secret) {
    socket.destroy();
    return;
  }
  const session = verifyToken(secret, match[1] ?? url.searchParams.get("token"));
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  relay.handleUpgrade(request, socket, head, (ws) => {
    log(`relay open for ${session.id}`);
    serveWisp(ws, {
      allowlist,
      byteBudget: Math.max(0, limits.relayBytesPerTokenPerDay - relayBytes.get(session.id)),
      onBytes: (count) => relayBytes.add(session.id, count),
      log: (message) => log(`relay ${session.id}: ${message}`),
    });
  });
});

app.listen(appPort, () =>
  log(`app on :${appPort}, dist ${distDir}, free agent ${freeAgentEnabled ? freeModel : "off"}`),
);
preview.listen(previewPort, () => log(`preview host on :${previewPort}`));
