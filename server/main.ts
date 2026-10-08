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
import { BodyTooLargeError, readBody } from "./body.ts";
import { serveFetchProxy } from "./fetch-proxy.ts";
import { DailyCounter, mintToken, verifyToken } from "./tokens.ts";
import { serveWisp } from "./wisp.ts";

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
  // A free-agent request carries the whole conversation, screenshots included.
  // 32 MB is Anthropic's own request limit, so the model's context window is
  // the binding constraint and its "prompt is too long" reply gets through.
  agentBodyBytes: Number(env.SPARKBOX_AGENT_BODY_BYTES ?? 32 * 1024 * 1024),
};
// The relay reaches any public host on 80/443 unless this narrows it to a
// list of names (exact or `*.suffix`).
const allowlist = (env.SPARKBOX_RELAY_ALLOWLIST ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
// Browsers send the page's origin on WebSocket upgrades; only Sparkbox pages
// may open the relay. Other tools can forge it, which is why the relay also
// needs a short-lived ticket minted for an invite.
const relayOrigins = new Set(
  [publicOrigin, ...(env.SPARKBOX_RELAY_ORIGINS ?? "").split(",")]
    .map((origin) => origin.trim().toLowerCase().replace(/\/$/, ""))
    .filter(Boolean),
);
const relayTicketDays = Number(env.SPARKBOX_RELAY_TICKET_DAYS ?? 1);
const relayConnectionsPerInvite = Number(env.SPARKBOX_RELAY_CONNECTIONS ?? 8);
const relayStreamsPerConnection = Number(env.SPARKBOX_RELAY_STREAMS ?? 256);
const freeAgentEnabled = Boolean(secret && openRouterKey && inviteCodes.length);
if (!secret)
  console.warn("SPARKBOX_TOKEN_SECRET is not set; invite tokens and the relay are disabled.");

const requests = new DailyCounter();
const relayBytes = new DailyCounter();
const relayConnections = new Map<string, number>();

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
      fetchUrl: secret ? `${publicOrigin}/api/fetch` : "",
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
  if (url.pathname === "/api/relay" && request.method === "POST") {
    // A short-lived ticket for the WISP relay, so the sandbox's connection URL
    // never carries the invite token and a copied URL expires on its own.
    if (!secret) return sendJson(response, 503, { error: "The relay is not enabled." });
    const session = verifyToken(secret, bearer(request));
    if (!session) return sendJson(response, 401, { error: "Enter a valid invite code first." });
    if (requests.add(`relay:${session.id}`) > 200)
      return sendJson(response, 429, { error: "Too many relay sessions today." });
    const ticket = mintToken(secret, relayTicketDays, { scope: "relay", id: session.id });
    return sendJson(response, 200, {
      url: `${publicOrigin.replace(/^http/, "ws")}/wisp/${encodeURIComponent(ticket)}/`,
    });
  }
  if (url.pathname === "/api/fetch") {
    // The download tool's fallback for sites without CORS headers. Bytes count
    // against the same daily budget as the relay. URLs are never logged.
    if (!secret) return sendJson(response, 503, { error: "The fetch proxy is not enabled." });
    const session = verifyToken(secret, bearer(request));
    if (!session) return sendJson(response, 401, { error: "Enter a valid invite code first." });
    return serveFetchProxy(request, response, url.searchParams.get("url"), {
      byteBudget: Math.max(0, limits.relayBytesPerTokenPerDay - relayBytes.get(session.id)),
      onBytes: (count) => relayBytes.add(session.id, count),
      log: (message) => log(`proxy ${session.id}: ${message}`),
      headers: isolation,
    });
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
      body = JSON.parse((await readBody(request, limits.agentBodyBytes)).toString("utf8"));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        log(`agent ${session.id}: request over ${limits.agentBodyBytes} bytes refused`);
        const megabytes = Math.round(limits.agentBodyBytes / 1024 ** 2);
        return sendJson(response, 413, {
          error: {
            message: `This conversation is too large for the free agent (over ${megabytes} MB). Start a new chat, or remove large images.`,
          },
        });
      }
      return sendJson(response, 400, { error: "Invalid request body." });
    }
    body.model = freeModel;
    if (typeof body.max_tokens !== "number" || body.max_tokens > limits.maxTokens)
      body.max_tokens = limits.maxTokens;
    let upstream: Response;
    try {
      upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${openRouterKey}`,
          "content-type": "application/json",
          "HTTP-Referer": publicOrigin || "https://sparkbox.local",
          "X-Title": "Sparkbox",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`agent ${session.id}: OpenRouter unreachable: ${reason}`);
      return sendJson(response, 502, {
        error: { message: `The host could not reach OpenRouter: ${reason}` },
      });
    }
    if (!upstream.ok) log(`agent ${session.id}: OpenRouter ${upstream.status}`);
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
  // A complete response, so proxies and clients see a refusal rather than a
  // connection that dropped mid-message.
  const refuse = (status: number, reason: string) => {
    const body = `${reason}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  };
  const origin = String(request.headers.origin ?? "")
    .toLowerCase()
    .replace(/\/$/, "");
  if (!origin || (relayOrigins.size && !relayOrigins.has(origin))) {
    log(`relay refused from origin ${origin || "(none)"}`);
    return refuse(403, "Forbidden");
  }
  // Only relay tickets open the relay; invite tokens do not.
  const session = verifyToken(secret, match[1] ?? url.searchParams.get("token"), "relay");
  if (!session) {
    log("relay refused: invalid or expired ticket");
    return refuse(401, "Unauthorized");
  }
  if ((relayConnections.get(session.id) ?? 0) >= relayConnectionsPerInvite) {
    log(`relay refused for ${session.id}: too many connections`);
    return refuse(429, "Too Many Requests");
  }
  relay.handleUpgrade(request, socket, head, (ws) => {
    relayConnections.set(session.id, (relayConnections.get(session.id) ?? 0) + 1);
    log(`relay open for ${session.id}`);
    ws.on("close", () => {
      const left = (relayConnections.get(session.id) ?? 1) - 1;
      if (left > 0) relayConnections.set(session.id, left);
      else relayConnections.delete(session.id);
    });
    serveWisp(ws, {
      allowlist,
      maxStreams: relayStreamsPerConnection,
      byteBudget: Math.max(0, limits.relayBytesPerTokenPerDay - relayBytes.get(session.id)),
      onBytes: (count) => relayBytes.add(session.id, count),
      log: (message) => log(`relay ${session.id}: ${message}`),
    });
  });
});

app.listen(appPort, () =>
  log(
    `app on :${appPort}, dist ${distDir}, free agent ${freeAgentEnabled ? freeModel : "off"}, relay ${
      secret ? (allowlist.length ? `to ${allowlist.length} hosts` : "to any public host") : "off"
    } for ${[...relayOrigins].join(", ") || "any origin"}`,
  ),
);
preview.listen(previewPort, () => log(`preview host on :${previewPort}`));
