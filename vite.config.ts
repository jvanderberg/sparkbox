import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The Wasmer sandbox runs WASIX processes in workers backed by SharedArrayBuffer,
// which browsers only allow on cross-origin-isolated pages. Static hosts that
// cannot set headers use the coi-serviceworker shim instead (see README).
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
};

/**
 * Two adjustments to the SDK's service worker (0.19.0):
 * 1. It forwards every request from the preview page into the guest, including
 *    cross-origin ones such as CDN scripts and map tiles, which then 404 inside
 *    the sandbox. Only same-origin requests belong to the guest.
 * 2. It sets Cross-Origin-Embedder-Policy: require-corp on guest responses,
 *    which blocks plain <script> and <img> loads from hosts without CORP
 *    headers inside the preview. A child of a require-corp page must itself
 *    carry a COEP, so the header cannot be dropped; `credentialless` keeps
 *    the embedding valid while allowing credential-free cross-origin loads.
 *    Safari lacks credentialless, so guidance also asks for `crossorigin`
 *    attributes on CDN tags.
 * Each replacement asserts its anchor so an SDK upgrade fails loudly here.
 */
function patchServiceWorker(source: string) {
  const replace = (from: string, to: string) => {
    if (!source.includes(from)) throw new Error(`service worker patch anchor missing: ${from}`);
    source = source.replace(from, to);
  };
  replace(
    'if (url.pathname.startsWith("/.wasmer/"))\n        return;',
    'if (url.origin !== self.location.origin || url.pathname.startsWith("/.wasmer/"))\n        return;',
  );
  replace(
    '    headers.set("cross-origin-embedder-policy", "require-corp");\n    headers.set("cross-origin-opener-policy", "same-origin");\n    // The HTTP host',
    '    headers.set("cross-origin-embedder-policy", "credentialless");\n    headers.set("cross-origin-opener-policy", "same-origin");\n    // The HTTP host',
  );
  return source;
}

/**
 * The preview host. Guest HTTP servers are reached through a service worker on
 * a second origin: `/wasmer-service-worker.js` plus the control document at
 * `/.wasmer/host.html`. Both scripts come from @wasmer/sdk unchanged. The same
 * build serves the app and the host; locally, 127.0.0.1 and localhost are the
 * two origins, and in production the build is deployed to two hostnames.
 */
function previewHost(): Plugin {
  // The SDK's exports map hides dist/, so locate the package from its browser entry.
  const require = createRequire(import.meta.url);
  const distRoot = dirname(require.resolve("@wasmer/sdk/browser"));
  const read = (name: string) => readFileSync(join(distRoot, name), "utf8");
  const files = () => ({
    "wasmer-service-worker.js": patchServiceWorker(read("service-worker.js")),
    ".wasmer/host.js": read("service-worker-host.js"),
    ".wasmer/host.html":
      '<!doctype html><meta charset="utf-8"><title>Sparkbox preview host</title><script type="module" src="/.wasmer/host.js"></script>',
  });
  const types: Record<string, string> = {
    js: "text/javascript; charset=utf-8",
    html: "text/html; charset=utf-8",
  };
  return {
    name: "sparkbox-preview-host",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0]?.replace(/^\//, "") ?? "";
        const body = files()[path as keyof ReturnType<typeof files>];
        if (body === undefined) return next();
        response.setHeader("content-type", types[path.split(".").pop() ?? ""] ?? "text/plain");
        for (const [key, value] of Object.entries(isolation)) response.setHeader(key, value);
        response.setHeader("service-worker-allowed", "/");
        response.end(body);
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(files()))
        this.emitFile({ type: "asset", fileName, source });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost()],
  server: { port: 4320, strictPort: true, headers: isolation, allowedHosts: [".ts.net"] },
  preview: { port: 4321, strictPort: true, headers: isolation, allowedHosts: [".ts.net"] },
  optimizeDeps: { exclude: ["@wasmer/sdk"] },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2023",
    modulePreload: { polyfill: false },
  },
});
