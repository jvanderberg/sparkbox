/**
 * End-to-end check of the host process: invite redemption, one free-agent
 * turn through the key proxy (a real, cheap model call), and sandbox
 * networking through the WISP relay. Needs the dev server plus
 * `npm run dev:server` with SPARKBOX_INVITE_CODES containing SPARKBOX_INVITE.
 *
 *   SPARKBOX_INVITE=friends-2026 npx tsx scripts/host-smoke.ts
 */
import { chromium } from "playwright";

const base = process.env.SPARKBOX_URL ?? "http://127.0.0.1:4320";
// SPARKBOX_RESOLVE="host IP" pins a hostname while its DNS record propagates.
const resolve = process.env.SPARKBOX_RESOLVE;
const launchArgs = resolve
  ? [`--host-resolver-rules=MAP ${resolve.split(" ")[0]} ${resolve.split(" ")[1]}`]
  : [];
const invite = process.env.SPARKBOX_INVITE ?? "";
if (!invite) throw new Error("Set SPARKBOX_INVITE");

const browser = await chromium.launch({ headless: true, args: launchArgs });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(base);

// The host hands out invites, so the app asks for one before anything else.
await page.getByLabel("Invite code").fill("wrong-code");
await page.getByRole("button", { name: "Continue" }).click();
await page.getByText("That invite code is not valid.").waitFor({ timeout: 20_000 });
await page.getByLabel("Invite code").fill(invite);
await page.getByRole("button", { name: "Continue" }).click();
await page.getByLabel("Invite code").waitFor({ state: "detached", timeout: 20_000 });
console.log("invite accepted");

// The sandbox boots with the relay, since the invite came first.
await page.getByLabel("Project name", { exact: true }).fill("Host smoke");
await page.getByRole("button", { name: "Create a project" }).click();
await page
  .locator(".workspace-header h1", { hasText: "Host smoke" })
  .waitFor({ state: "attached", timeout: 240_000 });

// One free-agent turn through the proxy.
await page.getByLabel("Message to agent").fill("Reply with exactly: PROXY_OK");
await page.getByLabel("Message to agent").press("Enter");
await page.getByRole("button", { name: "Stop generation" }).waitFor({ timeout: 30_000 });
await page
  .getByRole("button", { name: "Stop generation" })
  .waitFor({ state: "detached", timeout: 180_000 });
const thread = await page.locator(".chat-thread").innerText();
if (!/PROXY_OK/.test(thread)) throw new Error(`free agent reply missing: ${thread.slice(-400)}`);
console.log("free agent replied through the proxy");

type Exec = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
const run = (command: string) =>
  page.evaluate((c) => (window as unknown as { sparkboxExec: Exec }).sparkboxExec(c), command);
const fetched = await run(
  "node -e \"fetch('https://registry.npmjs.org/is-number/latest').then(r=>r.json()).then(j=>console.log('is-number', j.version))\"",
);
console.log(
  "fetch via relay:",
  fetched.exitCode,
  (fetched.stdout + fetched.stderr).trim().slice(0, 200),
);
if (!/is-number \d/.test(fetched.stdout)) throw new Error("relay fetch failed");
// Any public host is reachable; private addresses are not.
const open = await run(
  "node -e \"fetch('https://example.com/').then(r=>console.log('status', r.status)).catch(e=>console.log('blocked:', e.message))\"",
);
console.log("public host:", (open.stdout + open.stderr).trim().slice(0, 200));
if (!/status 200/.test(open.stdout)) throw new Error("relay did not reach example.com");
const blocked = await run(
  "node -e \"fetch('http://10.0.0.1/').then(r=>console.log('status', r.status)).catch(e=>console.log('blocked:', e.message))\"",
);
console.log("private host:", (blocked.stdout + blocked.stderr).trim().slice(0, 200));
if (/status \d/.test(blocked.stdout)) throw new Error("relay reached a private address");
// The invite token itself does not open the relay; only a ticket does.
const inviteSocket = await page.evaluate(
  () =>
    new Promise<string>((resolve) => {
      const token = localStorage.getItem("sparkbox:key:sparkbox") ?? "";
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/wisp/${token}/`);
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("error");
      ws.onclose = () => resolve("closed");
      setTimeout(() => resolve("timeout"), 10_000);
    }),
);
console.log("relay with the invite token:", inviteSocket);
if (inviteSocket === "open") throw new Error("relay accepted the invite token as a ticket");
const installed = await run(
  "pnpm add is-number@7.0.0 --ignore-scripts 2>&1 | tail -3 && node -e \"console.log('require ok', require('is-number')(5))\"",
);
console.log(
  "pnpm add:",
  installed.exitCode,
  (installed.stdout + installed.stderr).trim().slice(-300),
);
if (!/require ok true/.test(installed.stdout)) throw new Error("pnpm install via relay failed");
// The fetch proxy: a site without CORS headers through the host, no token refused,
// a loopback target refused.
// Three evaluations without inner function declarations: tsx wraps those in an
// esbuild helper that does not exist inside the page.
const proxyCall = (target: string, auth: boolean) =>
  page.evaluate(
    async ([target, auth]) => {
      const token = localStorage.getItem("sparkbox:key:sparkbox") ?? "";
      const config = (await (await fetch("/config.json")).json()) as { fetchUrl: string };
      const response = await fetch(`${config.fetchUrl}?url=${encodeURIComponent(target)}`, {
        headers: auth ? { authorization: `Bearer ${token}` } : {},
      });
      return {
        fetchUrl: config.fetchUrl,
        status: response.status,
        bytes: (await response.arrayBuffer()).byteLength,
      };
    },
    [target, auth] as const,
  );
const proxied = {
  example: await proxyCall("https://example.com/", true),
  noToken: await proxyCall("https://example.com/", false),
  loopback: await proxyCall("http://127.0.0.1:4330/healthz", true),
};
console.log("fetch proxy:", JSON.stringify(proxied));
if (!proxied.example.fetchUrl) throw new Error("config.json has no fetchUrl");
if (proxied.example.status !== 200 || proxied.example.bytes < 100)
  throw new Error("proxy did not fetch example.com");
if (proxied.noToken.status !== 401) throw new Error("proxy accepted a request without a token");
if (proxied.loopback.status !== 403) throw new Error("proxy reached a loopback address");
await browser.close();
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
console.log("ok host");
