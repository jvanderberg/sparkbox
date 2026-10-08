/**
 * The static file server the Preview button runs inside the sandbox with
 * Edge.js. It is written to /workspace/.sparkbox/serve.mjs on demand and is
 * excluded from the file list and from saved versions.
 */
export const serveScript = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] || 8080);
const root = path.resolve(process.cwd(), process.argv[3] || ".");
const skip = new Set(["node_modules", ".git", ".sparkbox", ".npm", ".pnpm", ".cache"]);

// Change detection: a cheap scan of mtimes every second. Pages served from
// here poll /__sparkbox/version and reload when it changes, which stands in
// for a dev server's live reload (the preview channel cannot carry sockets).
let version = "";
let versionAt = new Date().toISOString();
function scan(dir, acc) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(full, acc);
    else {
      try {
        const stat = fs.statSync(full);
        acc.count += 1;
        acc.latest = Math.max(acc.latest, stat.mtimeMs);
        acc.size += stat.size;
      } catch {}
    }
  }
  return acc;
}
function refreshVersion() {
  const acc = scan(root, { count: 0, latest: 0, size: 0 });
  const next = acc.count + ":" + Math.floor(acc.latest) + ":" + acc.size;
  if (next !== version) {
    version = next;
    versionAt = new Date().toISOString();
  }
}
refreshVersion();
setInterval(refreshVersion, 1000);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".geojson": "application/geo+json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/\\0/g, "");
  const target = path.normalize(path.join(root, clean));
  if (!target.startsWith(root)) return null;
  return target;
}

http
  .createServer((request, response) => {
    if ((request.url || "").startsWith("/__sparkbox/version")) {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ version, at: versionAt }));
      return;
    }
    let target = resolve(request.url || "/");
    if (!target) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory())
        target = path.join(target, "index.html");
      if (!fs.existsSync(target)) {
        const fallback = path.join(root, "index.html");
        if (!path.extname(target) && fs.existsSync(fallback)) target = fallback;
        else {
          response.writeHead(404, { "content-type": "text/plain" }).end("Not found: " + request.url);
          return;
        }
      }
      const extension = path.extname(target).toLowerCase();
      const data = fs.readFileSync(target);
      response.writeHead(200, {
        "content-type": types[extension] || "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(data);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    }
  })
  .listen(port, "0.0.0.0", () => console.log("Serving " + root + " on port " + port));
`;
