/**
 * Fetch proxy for the download tool. Browsers may not read responses from
 * sites that send no CORS headers; this route fetches a URL on the page's
 * behalf and streams the bytes back. GET only, no cookies or credentials
 * forwarded, private addresses refused (including through redirects), a
 * size cap, a timeout, and no URL logging (API keys travel in query strings).
 */
import { lookup } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

export const FETCH_PROXY_LIMIT = 25 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

/** Loopback, link-local, private, carrier-grade NAT and unspecified ranges. */
export function isPrivateAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) {
    return (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe8") ||
      ip.startsWith("fe9") ||
      ip.startsWith("fea") ||
      ip.startsWith("feb") ||
      ip.startsWith("ff")
    );
  }
  return true;
}

/** Validates the requested URL before any network access. */
export function proxyTarget(
  raw: string | null,
  exempt: ReadonlySet<string> = new Set(),
): { url: URL } | { status: number; error: string } {
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    return { status: 400, error: "A valid http(s) URL is required." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { status: 400, error: "Only http and https URLs can be fetched." };
  if (url.username || url.password)
    return { status: 400, error: "URLs with credentials are not fetched." };
  const host = url.hostname.toLowerCase();
  if (!host) return { status: 400, error: "A valid http(s) URL is required." };
  if (exempt.has(host)) return { url };
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (isIP(host.replace(/^\[|\]$/g, "")) && isPrivateAddress(host.replace(/^\[|\]$/g, "")))
  )
    return { status: 403, error: "That host is not reachable through the proxy." };
  return { url };
}

export type FetchProxyOptions = {
  /** Bytes this caller may still transfer today; 0 refuses the request. */
  byteBudget: number;
  onBytes: (count: number) => void;
  /** Hostname and status only; never the URL. */
  log: (message: string) => void;
  /** Extra response headers (the app's isolation headers). */
  headers?: Record<string, string>;
  /** Test seam: hostnames exempt from the public-address check. */
  exemptHosts?: string[];
};

async function hostIsPublic(hostname: string) {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return !isPrivateAddress(bare);
  try {
    const addresses = await lookup(bare, { all: true });
    return addresses.length > 0 && addresses.every((entry) => !isPrivateAddress(entry.address));
  } catch {
    return false;
  }
}

function sendError(response: ServerResponse, status: number, error: string, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify({ error }));
}

/** Handles GET /api/fetch?url=… for an already authenticated caller. */
export async function serveFetchProxy(
  request: IncomingMessage,
  response: ServerResponse,
  raw: string | null,
  options: FetchProxyOptions,
) {
  const headers = options.headers ?? {};
  const exempt = new Set(options.exemptHosts ?? []);
  if (request.method !== "GET") return sendError(response, 405, "GET only.", headers);
  const target = proxyTarget(raw, exempt);
  if ("error" in target) return sendError(response, target.status, target.error, headers);
  if (options.byteBudget <= 0)
    return sendError(response, 429, "Daily transfer limit reached for this invite.", headers);
  let url = target.url;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let upstream: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!exempt.has(url.hostname.toLowerCase()) && !(await hostIsPublic(url.hostname)))
      return sendError(response, 403, "That host is not reachable through the proxy.", headers);
    try {
      upstream = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "*/*", "user-agent": "Sparkbox fetch proxy" },
      });
    } catch {
      const timedOut = signal.aborted;
      options.log(`fetch ${url.hostname}: ${timedOut ? "timeout" : "unreachable"}`);
      return sendError(
        response,
        timedOut ? 504 : 502,
        timedOut
          ? "The server did not answer within 60 seconds."
          : "The server could not be reached.",
        headers,
      );
    }
    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      await upstream.body?.cancel().catch(() => {});
      const next = proxyTarget(new URL(location, url).href, exempt);
      if ("error" in next) return sendError(response, next.status, next.error, headers);
      url = next.url;
      upstream = null;
      continue;
    }
    break;
  }
  if (!upstream) return sendError(response, 502, "Too many redirects.", headers);
  const declared = Number(upstream.headers.get("content-length") ?? 0);
  const limit = Math.min(FETCH_PROXY_LIMIT, options.byteBudget);
  if (declared > limit) {
    await upstream.body?.cancel().catch(() => {});
    return sendError(
      response,
      413,
      `The file exceeds the ${Math.floor(limit / 1024 / 1024)} MiB limit.`,
      headers,
    );
  }
  options.log(`fetch ${url.hostname}: ${upstream.status}`);
  const out: Record<string, string> = { ...headers, "cache-control": "no-store" };
  const type = upstream.headers.get("content-type");
  if (type) out["content-type"] = type;
  if (declared) out["content-length"] = String(declared);
  response.writeHead(upstream.status, out);
  if (!upstream.body) return response.end();
  const reader = upstream.body.getReader();
  request.on("close", () => void reader.cancel().catch(() => {}));
  let sent = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sent += value.byteLength;
      options.onBytes(value.byteLength);
      if (sent > limit) {
        // Too late for a status code; cut the stream so the client sees a short read.
        await reader.cancel().catch(() => {});
        response.destroy();
        return;
      }
      response.write(value);
    }
  } finally {
    response.end();
  }
}
