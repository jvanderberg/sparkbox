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
    "wasmer-service-worker.js": read("service-worker.js"),
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
  server: { port: 4320, strictPort: true, headers: isolation },
  preview: { port: 4321, strictPort: true, headers: isolation },
  optimizeDeps: { exclude: ["@wasmer/sdk"] },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2023",
    modulePreload: { polyfill: false },
  },
});
