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
const viteVersion = process.env.SPARKBOX_VITE ?? "8.2.0";

const token = await fetch(new URL("/api/invite", base), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: invite }),
}).then(async (r) => ((await r.json()) as { token: string }).token);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
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

await write(
  "package.json",
  JSON.stringify(
    {
      name: "vite-hmr",
      private: true,
      type: "module",
      scripts: { dev: "vite --host 0.0.0.0 --port 5173" },
    },
    null,
    2,
  ),
);
await write(
  "index.html",
  '<!doctype html><html><head><meta charset="utf-8"><title>Vite HMR</title></head><body><h1 id="t">hello vite</h1><script type="module" src="/main.js"></script></body></html>',
);
await write("style.css", "h1 { color: rgb(10, 20, 30); }\n");
await write("main.js", 'import "./style.css";\nwindow.__marker = (window.__marker || 0) + 1;\n');
await write(
  "vite.config.js",
  "export default { server: { watch: { usePolling: true } }, build: { cssMinify: false } };\n",
);
await write(
  "sparkbox.json",
  JSON.stringify(
    {
      preview: { command: "npm run dev -- --host 0.0.0.0 --port 5173", port: 5173, directory: "." },
    },
    null,
    2,
  ),
);
const install = await run(`pnpm add -D vite@${viteVersion} --ignore-scripts 2>&1 | tail -2`);
console.log("install:", install.exitCode, install.stdout.trim().slice(-200));
if (install.exitCode !== 0) throw new Error("vite install failed");

const tabs = page.locator("nav.workspace-tabs");
await tabs.getByRole("button", { name: "Preview" }).click();
await page.locator(".preview-panel").getByRole("button", { name: "Preview" }).click();
const frame = page.locator("iframe.preview-frame");
await frame.waitFor({ timeout: 240_000 });
const content = frame.contentFrame();
await content.getByRole("heading", { name: "hello vite" }).waitFor({ timeout: 120_000 });
console.log("vite page served");
const inner = await (await frame.elementHandle())?.contentFrame();
if (!inner) throw new Error("no frame");
// Wait for the HMR client to connect through the tunnel.
await inner.waitForFunction(
  () => {
    const heading = document.querySelector("h1");
    return heading !== null && getComputedStyle(heading).color === "rgb(10, 20, 30)";
  },
  null,
  { timeout: 60_000 },
);
const before = await inner.evaluate(() => (window as unknown as { __marker: number }).__marker);
await write("style.css", "h1 { color: rgb(200, 30, 40); }\n");
await inner.waitForFunction(
  () => {
    const heading = document.querySelector("h1");
    return heading !== null && getComputedStyle(heading).color === "rgb(200, 30, 40)";
  },
  null,
  { timeout: 60_000 },
);
const after = await inner.evaluate(() => (window as unknown as { __marker: number }).__marker);
console.log(
  "css hot update applied; page reload count unchanged:",
  before === after,
  `(${before} → ${after})`,
);
if (before !== after) throw new Error("the page reloaded instead of hot-updating");
await page.getByRole("button", { name: "Logs" }).click();
console.log(
  "logs:",
  (await page.locator(".preview-logs").innerText()).slice(0, 300).replace(/\n+/g, " | "),
);
await browser.close();
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
console.log("ok vite hmr");
