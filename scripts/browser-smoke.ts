/**
 * Boots the app in headless Chromium against the dev server, creates a
 * project, waits for the Wasmer sandbox, starts the preview and checks the
 * iframe, the editor and the Changes view. No model calls.
 *
 *   npm run dev    (in another terminal)
 *   npm run test:browser
 */
import { mkdirSync } from "node:fs";
import { chromium, devices } from "playwright";

const base = process.env.SPARKBOX_URL ?? "http://127.0.0.1:4320";
mkdirSync("artifacts", { recursive: true });

async function run(label: string, options: { mobile?: boolean; dark?: boolean }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...(options.mobile ? devices["Pixel 7"] : { viewport: { width: 1280, height: 800 } }),
    colorScheme: options.dark ? "dark" : "light",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  if (!isolated) throw new Error("page is not cross-origin isolated");
  await page.getByLabel("New project name").fill(`Smoke ${label}`);
  await page.getByRole("button", { name: "Create" }).click();
  // On phones the status badge sits inside the collapsed menu.
  await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 180_000 });
  const tabs = page.locator("nav.workspace-tabs");
  await page.screenshot({ path: `artifacts/smoke-${label}-agent.png` });
  await tabs.getByRole("button", { name: "Files" }).click();
  // Phones start with the explorer collapsed to a rail.
  const expand = page.getByRole("button", { name: "Show file explorer" });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("treeitem", { name: /index\.html/ }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `artifacts/smoke-${label}-files.png` });
  await tabs.getByRole("button", { name: "Preview" }).click();
  await page.locator(".preview-panel").getByRole("button", { name: "Preview" }).click();
  const frame = page.locator("iframe.preview-frame");
  await frame.waitFor({ timeout: 180_000 });
  const content = frame.contentFrame();
  await content.getByRole("heading", { name: `Smoke ${label}` }).waitFor({ timeout: 60_000 });
  await content.getByRole("button", { name: /Clicked 0 times/ }).click();
  await content.getByRole("button", { name: /Clicked 1 times/ }).waitFor();
  await page.screenshot({ path: `artifacts/smoke-${label}-preview.png` });
  await tabs.getByRole("button", { name: "Files" }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("treeitem", { name: /app\.js/ }).click();
  await page.locator(".monaco-editor").first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `artifacts/smoke-${label}-editor.png` });
  await tabs.getByRole("button", { name: "Changes" }).click();
  await page.getByText("No changes since the saved version").waitFor({ timeout: 20_000 });
  await context.close();
  await browser.close();
  const real = errors.filter((text) => !/favicon|DevTools/.test(text));
  if (real.length) throw new Error(`console errors (${label}):\n${real.join("\n")}`);
  console.log(`ok ${label}`);
}

await run("desktop", {});
await run("mobile", { mobile: true, dark: true });
