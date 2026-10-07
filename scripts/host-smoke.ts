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
const invite = process.env.SPARKBOX_INVITE ?? "";
if (!invite) throw new Error("Set SPARKBOX_INVITE");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(base);
await page.getByLabel("New project name").fill("Host smoke");
await page.getByRole("button", { name: "Create" }).click();
await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 240_000 });

// Redeem the invite in the Sparkbox provider.
await page.getByLabel("Agent provider").selectOption({ label: "Sparkbox" });
await page.getByLabel("Invite code").fill("wrong-code");
await page.getByRole("button", { name: "Use invite" }).click();
await page.getByText("That invite code is not valid.").waitFor({ timeout: 20_000 });
await page.getByLabel("Invite code").fill(invite);
await page.getByRole("button", { name: "Use invite" }).click();
await page.getByLabel("Invite code").waitFor({ state: "detached", timeout: 20_000 });
console.log("invite accepted");

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

// Reopen the project so the sandbox boots with the relay, then use it.
await page.getByRole("button", { name: "← Projects" }).click();
await page.getByRole("button", { name: "Host smoke", exact: true }).click();
await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 240_000 });
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
const blocked = await run(
  "node -e \"fetch('https://example.com/').then(r=>console.log('status', r.status)).catch(e=>console.log('blocked:', e.message))\"",
);
console.log("blocked host:", (blocked.stdout + blocked.stderr).trim().slice(0, 200));
if (/status 200/.test(blocked.stdout)) throw new Error("allowlist did not block example.com");
const installed = await run(
  "pnpm add is-number@7.0.0 --ignore-scripts 2>&1 | tail -3 && node -e \"console.log('require ok', require('is-number')(5))\"",
);
console.log(
  "pnpm add:",
  installed.exitCode,
  (installed.stdout + installed.stderr).trim().slice(-300),
);
if (!/require ok true/.test(installed.stdout)) throw new Error("pnpm install via relay failed");
await browser.close();
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
console.log("ok host");
