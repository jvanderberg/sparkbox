/**
 * The static file server the Preview button runs inside the sandbox with
 * Edge.js. It is written to /workspace/.sparkbox/serve.mjs on demand and is
 * excluded from the file list and from saved versions.
 */
export const serveScript = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const port = Number(process.argv[2] || 8080);
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

// Pages report runtime errors to the Sparkbox tab, which shows them in the
// Preview panel and passes them to the agent. Injected into HTML responses.
const reporter =
  "<script>(function(){" +
  "function send(message){try{parent.postMessage({type:'sparkbox:page-error',message:String(message).slice(0,2000),href:location.pathname},'*')}catch(e){}}" +
  "window.addEventListener('error',function(e){var t=e.target;" +
  "if(t&&t!==window&&t.tagName){send('Failed to load '+t.tagName.toLowerCase()+' '+(t.src||t.href||''));return}" +
  "send((e.message||'Error')+(e.filename?' ('+e.filename.replace(location.origin,'')+':'+e.lineno+')':''))},true);" +
  "window.addEventListener('unhandledrejection',function(e){var r=e.reason;send('Unhandled promise rejection: '+(r&&r.message||r))});" +
  "var original=console.error;console.error=function(){send(Array.prototype.map.call(arguments,function(a){return a&&a.message||(typeof a==='object'?JSON.stringify(a):String(a))}).join(' '));original.apply(console,arguments)};" +
  "})();</script>";

function withReporter(html) {
  const index = html.search(/<\\/body>/i);
  return index >= 0 ? html.slice(0, index) + reporter + html.slice(index) : html + reporter;
}

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/\\0/g, "");
  const target = path.normalize(path.join(root, clean));
  if (!target.startsWith(root)) return null;
  return target;
}

http
  .createServer((request, response) => {
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
      const data =
        extension === ".html"
          ? Buffer.from(withReporter(fs.readFileSync(target, "utf8")))
          : fs.readFileSync(target);
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
