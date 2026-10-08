import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { bridgeScript } from "./src/sandbox/bridge-script.ts";

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
  // 3. Serve the page bridge at /__sparkbox/bridge.js and inject it into
  //    every HTML response from the guest, whichever server produced it.
  replace(
    "event.respondWith((async () => {\n        const route = activeRoute ?? await recoverRoute();",
    'if (url.pathname === "/__sparkbox/bridge.js") {\n        event.respondWith(new Response(SPARKBOX_BRIDGE, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "cross-origin-resource-policy": "cross-origin" } }));\n        return;\n    }\n    event.respondWith((async () => {\n        const route = activeRoute ?? await recoverRoute();',
  );
  replace(
    "    pending.resolve(new Response(bodyAllowed ? body : null, {",
    '    const injected = bodyAllowed && body && /^text\\/html/i.test(headers.get("content-type") ?? "") ? injectBridge(body, headers) : body;\n    pending.resolve(new Response(bodyAllowed ? injected : null, {',
  );
  source = `${source}
const SPARKBOX_BRIDGE = ${JSON.stringify(bridgeScript)};
const SPARKBOX_TAG = '<script src="/__sparkbox/bridge.js"></script>';
// The bridge must run before any page script so the WebSocket shim is in
// place: after <head> when there is one, else after <html> or <body>, else
// at the very start.
function injectBridge(body, headers) {
    const text = new TextDecoder().decode(body);
    let out = SPARKBOX_TAG + text;
    for (const opener of [/<head[^>]*>/i, /<html[^>]*>/i, /<body[^>]*>/i]) {
        const match = opener.exec(text);
        if (!match) continue;
        const after = match.index + match[0].length;
        out = text.slice(0, after) + SPARKBOX_TAG + text.slice(after);
        break;
    }
    headers.delete("content-length");
    return new TextEncoder().encode(out).buffer;
}`;
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

/**
 * The SDK's browser worker treats any unhandled promise rejection as a
 * worker failure and closes the whole worker pool, after which new guest
 * processes hang instead of failing. Rejections from guest JavaScript
 * (Node code running through Edge.js) reach that listener too, so one
 * uncaught rejection in a user script or inside the Vite dev server took
 * the sandbox down. Guest rejections are logged and ignored instead; the
 * SDK's own task failures still go through reportWorkerFailure.
 */
function patchBrowserWorker(source: string) {
  const anchor =
    'globalThis.addEventListener("unhandledrejection", (event) => {\n    event.preventDefault();\n    reportWorkerFailure(event.reason);\n});';
  if (!source.includes(anchor)) throw new Error("browser worker patch anchor missing");
  return source.replace(
    anchor,
    `globalThis.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    const reason = event.reason;
    if (reason && typeof reason === "object" && reason.name === "WasmerError") {
        reportWorkerFailure(reason);
        return;
    }
    console.warn("[sparkbox] unhandled promise rejection in guest JavaScript (the process continues):", reason);
});`,
  );
}

/** Serves the patched worker in development; the build emits it through wasmerRuntime. */
function wasmerWorkerPatch(): Plugin {
  return {
    name: "sparkbox-wasmer-worker-patch",
    enforce: "pre",
    transform(source, id) {
      if (!id.split("?")[0]?.endsWith("/@wasmer/sdk/dist/browser-worker.js")) return;
      return { code: patchBrowserWorker(source), map: null };
    },
  };
}

/**
 * The SDK starts its worker and wasm-bindgen module by URL
 * (`new URL("./browser-worker.js", import.meta.url)`), which Vite does not
 * traverse: the worker ends up bundled while the binding it imports is copied
 * raw and then looks for an unhashed wasm file that does not exist, so every
 * sandbox process dies in production. Emit the runtime files under one
 * versioned directory with their relative layout intact and point the two
 * references in the SDK entry at it. Modelled on wasmer-sh's build.
 */
function wasmerRuntime(): Plugin {
  const require = createRequire(import.meta.url);
  const sdkDist = dirname(require.resolve("@wasmer/sdk/browser"));
  const sdkRoot = resolve(sdkDist, "..");
  const version = (
    JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as { version: string }
  ).version;
  const directory = `wasmer-runtime-${version}`;
  const entry = resolve(sdkDist, "index.js");
  const workerUrl = "./browser-worker.js";
  const bindingUrl = "../pkg/wasmer_sdk_js.js";
  return {
    name: "sparkbox-wasmer-runtime",
    apply: "build",
    enforce: "pre",
    buildStart() {
      const files = new Map<string, Buffer>();
      const collect = (file: string) => {
        if (files.has(file)) return;
        const source = readFileSync(file);
        files.set(file, source);
        for (const match of source
          .toString()
          .matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
          const target = resolve(dirname(file), match[1] as string);
          if (existsSync(target) && statSync(target).isFile()) collect(target);
        }
      };
      const collectDirectory = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const file = join(dir, name);
          if (statSync(file).isDirectory()) collectDirectory(file);
          else files.set(file, readFileSync(file));
        }
      };
      collect(resolve(sdkDist, "browser-worker.js"));
      collect(resolve(sdkRoot, "pkg/wasmer_sdk_js.js"));
      files.set(
        resolve(sdkRoot, "pkg/wasmer_sdk_js_bg.wasm"),
        readFileSync(resolve(sdkRoot, "pkg/wasmer_sdk_js_bg.wasm")),
      );
      if (existsSync(resolve(sdkRoot, "pkg/snippets")))
        collectDirectory(resolve(sdkRoot, "pkg/snippets"));
      for (const [file, source] of files)
        this.emitFile({
          type: "asset",
          fileName: `${directory}/${relative(sdkRoot, file).split(sep).join("/")}`,
          source:
            file === resolve(sdkDist, "browser-worker.js")
              ? patchBrowserWorker(source.toString())
              : source,
        });
    },
    transform(source, id) {
      if (id !== entry) return;
      const rewrite = (url: string, path: string) => {
        const single = `new URL('${url}', import.meta.url)`;
        const double = `new URL("${url}", import.meta.url)`;
        if (!source.includes(single) && !source.includes(double))
          this.error(`SDK runtime URL not found in ${id}: ${url}`);
        const replacement = `new URL("/${directory}/${path}", self.location.origin)`;
        source = source.replaceAll(single, replacement).replaceAll(double, replacement);
      };
      rewrite(workerUrl, "dist/browser-worker.js");
      rewrite(bindingUrl, "pkg/wasmer_sdk_js.js");
      return { code: source, map: null };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost(), wasmerWorkerPatch(), wasmerRuntime()],
  server: {
    port: 4320,
    strictPort: true,
    headers: isolation,
    allowedHosts: [".ts.net"],
    // Benchmark exports under artifacts/ include tsconfig.json files, which
    // would otherwise force a full reload of the app under test.
    watch: { ignored: ["**/artifacts/**"] },
    // The host process (npm run dev:server) provides config, invites, the
    // free-agent proxy and the WISP relay during development.
    proxy: {
      "/api": { target: "http://127.0.0.1:4330", ws: true },
      "/config.json": { target: "http://127.0.0.1:4330" },
      "/wisp": { target: "ws://127.0.0.1:4330", ws: true },
    },
  },
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
