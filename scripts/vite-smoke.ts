/**
 * Vite inside the sandbox with real HMR through the WebSocket tunnel.
 * Needs the dev server, the host process (for the relay) and an invite:
 *
 *   SPARKBOX_INVITE=friends-2026 npx tsx scripts/vite-smoke.ts
 */
import { chromium } from "playwright";

const base = process.env.SPARKBOX_URL ?? "http://127.0.0.1:4320";
const invite = process.env.SPARKBOX_INVITE ?? "";
if (!invite) throw new Error("Set SPARKBOX_INVITE");
const viteVersion = process.env.SPARKBOX_VITE ?? "7";

const token = await fetch(new URL("/api/invite", base), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: invite }),
}).then(async (r) => ((await r.json()) as { token: string }).token);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
// Vite's client inside the preview frame logs when its HMR socket is up.
// The app's own Vite client logs the same line on the main page, so only
// connections after a call to waitForHmr count.
const hmrWaiters: (() => void)[] = [];
page.on("console", (message) => {
  if (message.page() === page && message.text() === "[vite] connected.")
    for (const resolve of hmrWaiters.splice(0)) resolve();
});
const waitForHmr = (label: string) =>
  withLogs(
    label,
    new Promise<void>((resolve, reject) => {
      hmrWaiters.push(resolve);
      setTimeout(() => reject(new Error("HMR client never connected")), 60_000);
    }),
  );
await page.goto(base);
await page.evaluate((t) => localStorage.setItem("sparkbox:key:sparkbox", t), token);
await page.getByLabel("New project name").fill("Vite HMR");
await page.getByRole("button", { name: "Create" }).click();
await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 240_000 });

type Exec = (c: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
type Write = (p: string, c: string) => Promise<void>;
const run = (c: string) =>
  page.evaluate((c) => (window as unknown as { sparkboxExec: Exec }).sparkboxExec(c), c);
const write = (p: string, c: string) =>
  page.evaluate(
    (args: { p: string; c: string }) =>
      (window as unknown as { sparkboxWrite: Write }).sparkboxWrite(args.p, args.c),
    { p, c },
  );

const dumpLogs = async (label: string) => {
  await page
    .getByRole("button", { name: "Logs" })
    .click()
    .catch(() => {});
  const logs = await page
    .locator(".preview-logs")
    .innerText()
    .catch(() => "(no logs panel)");
  console.log(`${label} logs:\n${logs.slice(-3000)}`);
};
const withLogs = async <T>(label: string, work: Promise<T>): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    await dumpLogs(label);
    throw error;
  }
};

await write(
  "package.json",
  JSON.stringify(
    {
      name: "vite-hmr",
      private: true,
      type: "module",
      scripts: { dev: "node .sparkbox/vite.mjs --host 0.0.0.0 --port 5173" },
      pnpm: {
        overrides: { esbuild: "npm:esbuild-wasm@0.28.2", rollup: "npm:@rollup/wasm-node@4.64.2" },
      },
    },
    null,
    2,
  ),
);
await write(
  "index.html",
  '<!doctype html><html><head><meta charset="utf-8"><title>Vite HMR</title></head><body><h1 id="t">hello vite</h1><script type="module" src="/main.ts"></script></body></html>',
);
await write("style.css", "h1 { color: rgb(10, 20, 30); }\n");
await write(
  "main.ts",
  'import "./style.css";\nconst marker: number = ((window as unknown as { __marker?: number }).__marker ?? 0) + 1;\n(window as unknown as { __marker: number }).__marker = marker;\ndocument.querySelector("h1")!.dataset.ts = String(marker satisfies number);\n',
);
await write("vite.config.js", "export default { server: { watch: { usePolling: true } } };\n");
await write(
  "sparkbox.json",
  JSON.stringify(
    {
      preview: {
        command: "node .sparkbox/vite.mjs --host 0.0.0.0 --port 5173",
        port: 5173,
        directory: ".",
      },
    },
    null,
    2,
  ),
);
const install = await run(
  `pnpm add -D vite@${viteVersion} acorn es-module-lexer@1 --ignore-scripts`,
);
console.log("install:", install.exitCode, (install.stdout + install.stderr).trim().slice(-200));
if (install.exitCode !== 0) throw new Error("vite install failed");

const tabs = page.locator("nav.workspace-tabs");
await tabs.getByRole("button", { name: "Preview" }).click();
await page.locator(".preview-panel").getByRole("button", { name: "Preview" }).click();
const frame = page.locator("iframe.preview-frame");
await withLogs("start", frame.waitFor({ timeout: 240_000 }));
const content = frame.contentFrame();
await withLogs(
  "page",
  content.getByRole("heading", { name: "hello vite" }).waitFor({ timeout: 120_000 }),
);
console.log("vite page served");
const hmrConnection = waitForHmr("hmr connect");
const inner = await (await frame.elementHandle())?.contentFrame();
if (!inner) throw new Error("no frame");
await withLogs(
  "ts",
  inner.waitForFunction(() => document.querySelector("h1")?.dataset.ts === "1", null, {
    timeout: 60_000,
  }),
);
console.log("typescript entry transformed and executed");
// Wait for the stylesheet (served as a module) and the HMR client to connect through the tunnel.
await withLogs(
  "css",
  inner.waitForFunction(
    () => {
      const heading = document.querySelector("h1");
      return heading !== null && getComputedStyle(heading).color === "rgb(10, 20, 30)";
    },
    null,
    { timeout: 60_000 },
  ),
);
await hmrConnection;
console.log("hmr client connected through the tunnel");
const before = await inner.evaluate(() => (window as unknown as { __marker: number }).__marker);

await write("style.css", "h1 { color: rgb(200, 30, 40); }\n");
await withLogs(
  "hmr",
  inner.waitForFunction(
    () => {
      const heading = document.querySelector("h1");
      return heading !== null && getComputedStyle(heading).color === "rgb(200, 30, 40)";
    },
    null,
    { timeout: 60_000 },
  ),
);
const after = await inner.evaluate(() => (window as unknown as { __marker: number }).__marker);
console.log(
  "css hot update applied; page reload count unchanged:",
  before === after,
  `(${before} -> ${after})`,
);
if (before !== after) throw new Error("the page reloaded instead of hot-updating");

// Phase two: React with Fast Refresh. Dependencies are pre-bundled by the
// page's esbuild through Vite's own plugin callbacks; the refresh transform
// is Babel running inside the sandbox.
const reactInstall = await run(
  "pnpm add react react-dom --ignore-scripts && pnpm add -D @vitejs/plugin-react@5 --ignore-scripts",
);
console.log(
  "react install:",
  reactInstall.exitCode,
  (reactInstall.stdout + reactInstall.stderr).trim().slice(-160),
);
if (reactInstall.exitCode !== 0) throw new Error("react install failed");
await write(
  "src/App.tsx",
  `import { useState } from "react";
export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>hello react</h1>
      <button type="button" onClick={() => setCount((n) => n + 1)}>count {count}</button>
    </main>
  );
}
`,
);
await write(
  "src/main.tsx",
  `import { createRoot } from "react-dom/client";
import { App } from "./App";
import "../style.css";
createRoot(document.getElementById("root")!).render(<App />);
`,
);
await write(
  "index.html",
  '<!doctype html><html><head><meta charset="utf-8"><title>Vite React</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
);
await write(
  "vite.config.js",
  'import react from "@vitejs/plugin-react";\nexport default { plugins: [react()] };\n',
);
const panel = page.locator(".preview-panel");
await page.waitForTimeout(6000);
// Vite restarts itself after the config change; the preview must survive that.
const afterRestart = await frame
  .contentFrame()
  .locator("body")
  .evaluate(async () => {
    const out: Record<string, string> = { body: document.body.innerText.slice(0, 80) };
    for (const path of ["/@vite/client", "/src/main.tsx"]) {
      try {
        const r = await fetch(path);
        out[path] = `${r.status} ${(await r.text()).slice(0, 160).replace(/\n/g, " ")}`;
      } catch (e) {
        out[path] = `ERR ${(e as Error).message}`;
      }
    }
    return out;
  })
  .catch((e: Error) => ({ error: e.message }));
console.log("after vite self-restart:", JSON.stringify(afterRestart));
const restart = page.getByRole("button", { name: "Restart", exact: true });
if (await restart.isVisible()) await restart.click();
else {
  console.log(
    "preview not running after config change; error:",
    await panel
      .locator(".preview-error")
      .innerText()
      .catch(() => "(none)"),
  );
  await page.screenshot({ path: "/tmp/vite-react-state.png" });
  console.log(
    "page text:",
    JSON.stringify((await page.locator("body").innerText()).slice(0, 1500)),
  );
  await dumpLogs("before restart");
  await panel.getByRole("button", { name: "Preview" }).click();
}
const reactConnection = waitForHmr("react hmr connect");
await withLogs(
  "react page",
  content.getByRole("heading", { name: "hello react" }).waitFor({ timeout: 240_000 }),
);
console.log("react app rendered from pre-bundled dependencies");
await reactConnection;
const counter = content.getByRole("button", { name: /count/ });
await counter.click();
await counter.click();
await withLogs(
  "react count",
  content.getByRole("button", { name: "count 2" }).waitFor({ timeout: 10_000 }),
);
await write(
  "src/App.tsx",
  `import { useState } from "react";
export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>hello refresh</h1>
      <button type="button" onClick={() => setCount((n) => n + 1)}>count {count}</button>
    </main>
  );
}
`,
);
await withLogs(
  "fast refresh",
  content.getByRole("heading", { name: "hello refresh" }).waitFor({ timeout: 60_000 }),
);
const preserved = await content.getByRole("button", { name: "count 2" }).isVisible();
console.log("fast refresh applied; component state preserved:", preserved);
if (!preserved) throw new Error("Fast Refresh lost component state (the page reloaded)");
// An edit made by a shell command is noticed when the command finishes.
const shellEdit = Date.now();
await run(
  `node -e "const fs=require('fs');fs.writeFileSync('src/App.tsx',fs.readFileSync('src/App.tsx','utf8').replace('hello refresh','hello shell'))"`,
);
await withLogs(
  "shell edit",
  content.getByRole("heading", { name: "hello shell" }).waitFor({ timeout: 60_000 }),
);
const shellPreserved = await content.getByRole("button", { name: "count 2" }).isVisible();
console.log(
  `shell edit hot updated in ${Date.now() - shellEdit} ms; state preserved:`,
  shellPreserved,
);
if (!shellPreserved) throw new Error("shell edit lost component state");
await dumpLogs("final");
await browser.close();
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
console.log("ok vite hmr");
