// Starts Vite inside the Sparkbox sandbox. The sandbox runtime cannot run
// esbuild, Rollup's parser or WebAssembly, so Vite's installed files are
// rewritten once to use the Sparkbox replacements, then Vite's own CLI runs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const require = createRequire(join(root, "package.json"));
const marker = "/* sparkbox-patched */";

function fail(message) {
  console.error(`sparkbox: ${message}`);
  process.exit(1);
}

let vitePackage;
try {
  vitePackage = require.resolve("vite/package.json");
} catch {
  fail(
    "Vite is not installed. Run: pnpm add -D vite@7 @vitejs/plugin-react acorn es-module-lexer@1 --ignore-scripts",
  );
}
const viteDir = dirname(vitePackage);
const viteVersion = JSON.parse(readFileSync(vitePackage, "utf8")).version;
if (!/^7\./.test(viteVersion))
  fail(`Vite ${viteVersion} is installed; Sparkbox supports Vite 7 (pnpm add -D vite@7).`);
function resolveOrFail(specifier, dependency) {
  try {
    return require.resolve(specifier);
  } catch {
    return fail(
      `${dependency} is missing. Run: pnpm add -D acorn es-module-lexer@1 --ignore-scripts`,
    );
  }
}
resolveOrFail("acorn", "acorn");

const shimDir = join(root, ".sparkbox");
const esbuildShim = pathToFileURL(join(shimDir, "esbuild-shim.js")).href;
const parseAstShim = pathToFileURL(join(shimDir, "rollup-parse-ast.js")).href;
const lexerPath = resolveOrFail("es-module-lexer/js", "es-module-lexer");
const lexerVersion = JSON.parse(
  readFileSync(join(dirname(dirname(lexerPath)), "package.json"), "utf8"),
).version;
if (!/^1\./.test(lexerVersion))
  fail(
    `es-module-lexer ${lexerVersion} is installed; Vite 7 needs version 1 (pnpm add -D es-module-lexer@1).`,
  );
const lexer = pathToFileURL(lexerPath).href;
if (!existsSync(lexerPath)) fail("es-module-lexer/dist/lexer.asm.js is missing");

function patch(file, edit) {
  const path = join(viteDir, file);
  const source = readFileSync(path, "utf8");
  if (source.startsWith(marker)) return;
  const patched = edit(source);
  if (patched === source) fail(`could not patch ${file}; this Vite build is not supported`);
  writeFileSync(path, `${marker}\n${patched}`);
}

patch("dist/node/index.js", (source) =>
  source
    .replace('from "rollup/parseAst";', `from ${JSON.stringify(parseAstShim)};`)
    .replace('from "esbuild";', `from ${JSON.stringify(esbuildShim)};`),
);
patch("dist/node/chunks/config.js", (source) => {
  const start = source.indexOf("//#region ../../node_modules/.pnpm/es-module-lexer@");
  const end = source.indexOf("//#endregion", start);
  if (start < 0 || end < 0) return source;
  // The asm.js lexer needs no initialisation, but Vite awaits `init`.
  const lexerImport = `import { parse } from ${JSON.stringify(lexer)};\nconst init = Promise.resolve();\n`;
  return (source.slice(0, start) + lexerImport + source.slice(end))
    .replace('from "rollup/parseAst";', `from ${JSON.stringify(parseAstShim)};`)
    .replace('from "esbuild";', `from ${JSON.stringify(esbuildShim)};`);
});

// Vite's CLI only installs these handlers outside node_modules; without
// them a failure inside an async handler disappears.
process.on("unhandledRejection", (error) => console.error("sparkbox: unhandled rejection", error));
process.on("uncaughtException", (error) => console.error("sparkbox: uncaught exception", error));

// Arguments: --host <name>, --port <n>, --debug [namespaces]; the rest is ignored.
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length && !args[index + 1].startsWith("-")
    ? args[index + 1]
    : undefined;
};
const host = option("--host") ?? (args.includes("--host") ? "0.0.0.0" : "localhost");
const port = Number(option("--port") ?? 5173);
if (args.includes("--debug") || args.includes("-d")) {
  const scope = option("--debug") ?? option("-d");
  process.env.DEBUG = scope
    ? scope
        .split(",")
        .map((part) => `vite:${part}`)
        .join(",")
    : "vite:*";
}

// File notifications do not exist in this runtime and modification times
// never change, so Vite's watcher is replaced by a content scan: every file
// outside dependency and output folders is hashed twice a second and Vite's
// own change handlers are invoked for anything that differs.
function sparkboxWatcher() {
  const ignored = new Set(["node_modules", ".git", "dist", ".sparkbox", ".vite", ".cache"]);
  const limit = 2 * 1024 * 1024;
  return {
    name: "sparkbox-watcher",
    configureServer(server) {
      const root = server.config.root;
      let seen = new Map();
      let ready = false;
      let busy = false;
      const digest = (file) => {
        const stat = statSync(file);
        if (stat.size > limit) return `size:${stat.size}`;
        return createHash("md5").update(readFileSync(file)).digest("hex");
      };
      const scan = () => {
        const current = new Map();
        const walk = (directory) => {
          let entries;
          try {
            entries = readdirSync(directory, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (ignored.has(entry.name)) continue;
            const full = join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
              try {
                current.set(full, digest(full));
              } catch {}
            }
          }
        };
        walk(root);
        if (ready) {
          for (const [file, hash] of current) {
            const previous = seen.get(file);
            if (previous === undefined) server.watcher.emit("add", file);
            else if (previous !== hash) server.watcher.emit("change", file);
          }
          for (const file of seen.keys())
            if (!current.has(file)) server.watcher.emit("unlink", file);
        }
        seen = current;
        ready = true;
      };
      scan();
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        try {
          scan();
        } catch (error) {
          console.error("sparkbox: file scan failed", error);
        } finally {
          busy = false;
        }
      }, 500);
      server.httpServer?.once("close", () => clearInterval(timer));
    },
  };
}

const { createServer } = await import(pathToFileURL(join(viteDir, "dist/node/index.js")).href);
const server = await createServer({
  clearScreen: false,
  server: { host, port, strictPort: true, watch: null },
  plugins: [sparkboxWatcher()],
});
await server.listen();
server.printUrls();
