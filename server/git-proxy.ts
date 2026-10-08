/**
 * Relay for git's smart HTTP protocol and the few GitHub API reads that a
 * browser cannot make itself. The page's git client (isomorphic-git) talks to
 * github.com, which sends no CORS headers; this route forwards exactly those
 * requests, with the user's Authorization header, and stores nothing.
 *
 *   /api/git/github.com/<owner>/<repo>.git/info/refs?service=...   GET
 *   /api/git/github.com/<owner>/<repo>.git/git-upload-pack         POST
 *   /api/git/github.com/<owner>/<repo>.git/git-receive-pack        POST
 *   /api/git/api.github.com/repos/<owner>/<repo>/actions/jobs/<id>/logs   GET
 *
 * Nothing about the request is logged beyond the verb and the host.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

const TIMEOUT_MS = 120_000;
const name = /^[A-Za-z0-9_.-]+$/;

/** Validate a relayed path and return the upstream URL, or an error. */
export function gitProxyTarget(
  path: string,
  method: string,
  search: string,
): { url: string; kind: "git" | "logs" } | { status: number; error: string } {
  const smart =
    /^github\.com\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
      path,
    );
  if (smart) {
    const [, owner = "", repo = "", action = ""] = smart;
    if (!name.test(owner) || !name.test(repo)) return { status: 400, error: "Bad repository." };
    if (action === "info/refs") {
      if (method !== "GET") return { status: 405, error: "GET only." };
      const service = new URLSearchParams(search).get("service");
      if (service !== "git-upload-pack" && service !== "git-receive-pack")
        return { status: 400, error: "Unknown git service." };
    } else if (method !== "POST") return { status: 405, error: "POST only." };
    return { url: `https://github.com/${owner}/${repo}.git/${action}${search}`, kind: "git" };
  }
  const logs = /^api\.github\.com\/repos\/([^/]+)\/([^/]+)\/actions\/jobs\/(\d+)\/logs$/.exec(path);
  if (logs) {
    const [, owner = "", repo = "", job = ""] = logs;
    if (!name.test(owner) || !name.test(repo)) return { status: 400, error: "Bad repository." };
    if (method !== "GET") return { status: 405, error: "GET only." };
    return {
      url: `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${job}/logs`,
      kind: "logs",
    };
  }
  return { status: 404, error: "Not a relayed GitHub path." };
}

export async function serveGitProxy(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  search: string,
  options: { headers?: Record<string, string>; log: (message: string) => void },
) {
  const extra = options.headers ?? {};
  const send = (status: number, error: string) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extra });
    response.end(JSON.stringify({ error }));
  };
  const method = request.method ?? "GET";
  const target = gitProxyTarget(path, method, search);
  if ("error" in target) return send(target.status, target.error);
  const headers: Record<string, string> = { "user-agent": "Sparkbox git relay" };
  for (const header of [
    "authorization",
    "content-type",
    "accept",
    "git-protocol",
    "content-encoding",
  ]) {
    const value = request.headers[header];
    if (typeof value === "string") headers[header] = value;
  }
  if (target.kind === "logs") headers.accept = "application/vnd.github+json";
  let upstream: Response;
  try {
    upstream = await fetch(target.url, {
      method,
      headers,
      body: method === "POST" ? (Readable.toWeb(request) as ReadableStream) : undefined,
      // @ts-expect-error Node's fetch needs duplex for streamed request bodies.
      duplex: method === "POST" ? "half" : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (error) {
    options.log(
      `git relay ${method} ${target.kind}: ${error instanceof Error ? error.message : "failed"}`,
    );
    return send(502, "GitHub could not be reached.");
  }
  options.log(`git relay ${method} ${target.kind}: ${upstream.status}`);
  const out: Record<string, string> = { ...extra, "cache-control": "no-cache" };
  for (const header of ["content-type", "content-encoding"]) {
    const value = upstream.headers.get(header);
    if (value) out[header] = value;
  }
  if (target.kind === "logs") {
    // The log is plain text behind a redirect; hand it over as text.
    out["content-type"] = "text/plain; charset=utf-8";
    delete out["content-encoding"];
  }
  response.writeHead(upstream.status, out);
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
}
