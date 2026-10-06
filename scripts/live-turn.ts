/**
 * One paid model turn through the real UI. Explicit opt-in only:
 *
 *   SPARKBOX_ANTHROPIC_KEY=sk-ant-… npm run test:live:anthropic
 *   SPARKBOX_OPENAI_KEY=sk-…        npm run test:live:openai
 *   SPARKBOX_OPENROUTER_KEY=sk-or-… npm run test:live:openrouter
 *
 * The key is typed into the test browser's ephemeral profile and never
 * printed. SPARKBOX_MODEL overrides the provider's default model.
 * Requires `npm run dev` on 127.0.0.1:4320.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const providerArg = process.argv[2] ?? "anthropic";
const providers = {
  anthropic: { env: "SPARKBOX_ANTHROPIC_KEY", keyLabel: "Anthropic API key", option: "Claude" },
  openai: { env: "SPARKBOX_OPENAI_KEY", keyLabel: "OpenAI API key", option: "OpenAI" },
  openrouter: {
    env: "SPARKBOX_OPENROUTER_KEY",
    keyLabel: "OpenRouter API key",
    option: "OpenRouter",
  },
} as const;
const provider = providers[providerArg as keyof typeof providers];
if (!provider) throw new Error(`Unknown provider ${providerArg}`);
const key = process.env[provider.env];
if (!key) throw new Error(`Set ${provider.env}`);
const base = process.env.SPARKBOX_URL ?? "http://127.0.0.1:4320";
const model = process.env.SPARKBOX_MODEL ?? "";
const label = `live-${providerArg}`;
mkdirSync("artifacts", { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text().replaceAll(key, "[key]"));
});
page.on("pageerror", (error) => errors.push(error.message.replaceAll(key, "[key]")));

await page.goto(base);
await page.getByLabel("New project name").fill(`Live ${provider.option}`);
await page.getByRole("button", { name: "Create" }).click();
await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 180_000 });
console.log("sandbox ready");

await page.getByLabel("Agent provider").selectOption({ label: provider.option });
await page.getByLabel(provider.keyLabel).fill(key);
await page.getByRole("button", { name: "Save key" }).click();
// The connection panel closes once the provider is ready.
await page.getByLabel(provider.keyLabel).waitFor({ state: "detached" });
if (model) {
  await page.getByRole("button", { name: "Agent connection settings" }).click();
  await page.getByLabel("Model").fill(model);
  await page.getByLabel("Model").press("Tab");
  await page.getByRole("button", { name: "Agent connection settings" }).click();
}

const scenario = process.env.SPARKBOX_SCENARIO ?? "edit";
const prompt =
  scenario === "map"
    ? "Replace this page with a Leaflet map of Oak Park, Illinois centered on 41.885, -87.785 at zoom 13, with OpenStreetMap tiles and one marker on the village hall. Load Leaflet from a CDN. Keep the page heading as an h1 that says 'Oak Park map'. Reply in two sentences."
    : "Change the page heading to 'Hello from Sparkbox', add a short paragraph under it that explains the page was edited by an agent running in the browser, and run `ls -la` so I can see the project files. Reply in two sentences.";
const expectedHeading = scenario === "map" ? "Oak Park map" : "Hello from Sparkbox";
await page.getByLabel("Message to agent").fill(prompt);
await page.getByLabel("Message to agent").press("Enter");
const stop = page.getByRole("button", { name: "Stop generation" });
await stop.waitFor({ timeout: 30_000 });
console.log("turn started");
await stop.waitFor({ state: "detached", timeout: 420_000 });
console.log("turn finished");
await page.waitForTimeout(1000);
await page.screenshot({ path: `artifacts/${label}-chat.png`, fullPage: true });

const rows = await page.locator(".chat-thread").innerText();
const assistant = await page
  .locator(".chat-thread .markdown, .chat-thread [data-role=assistant]")
  .allInnerTexts()
  .catch(() => []);
void assistant;
console.log("---- conversation ----");
console.log(rows.replaceAll(key, "[key]").slice(0, 4000));
console.log("----------------------");

const tabs = page.locator("nav.workspace-tabs");
await tabs.getByRole("button", { name: "Files" }).click();
await page.getByRole("treeitem", { name: /index\.html/ }).click();
await page.locator(".monaco-editor").first().waitFor({ timeout: 30_000 });
await page.screenshot({ path: `artifacts/${label}-editor.png` });
const editorText = await page.locator(".monaco-editor .view-lines").first().innerText();
console.log(
  "editor shows new heading:",
  editorText.replaceAll("\u00a0", " ").includes(expectedHeading),
);
await tabs.getByRole("button", { name: "Changes" }).click();
await page.locator(".file-diff").first().waitFor({ timeout: 20_000 });
console.log("changed files:", await page.locator(".file-diff summary code").allInnerTexts());
await page.screenshot({ path: `artifacts/${label}-changes.png`, fullPage: true });
await tabs.getByRole("button", { name: "Preview" }).click();
await page.locator(".preview-panel").getByRole("button", { name: "Preview" }).click();
const frame = page.locator("iframe.preview-frame");
await frame.waitFor({ timeout: 180_000 });
await frame
  .contentFrame()
  .getByRole("heading", { name: expectedHeading })
  .waitFor({ timeout: 60_000 });
await page.screenshot({ path: `artifacts/${label}-preview.png` });
if (scenario === "map") {
  await frame
    .contentFrame()
    .locator(".leaflet-container .leaflet-tile-loaded")
    .first()
    .waitFor({ timeout: 60_000 });
  console.log("preview shows a Leaflet map with loaded tiles");
}
await page.waitForTimeout(1500);
console.log("preview shows the new heading");
console.log("page errors shown:", await page.locator(".preview-page-errors").allTextContents());
// Reload: transcript and files must come back.
await page.reload();
await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 180_000 });
await tabs.getByRole("button", { name: "Agent" }).click();
await page.locator(".chat-thread").getByText(expectedHeading).first().waitFor({ timeout: 20_000 });
console.log("transcript restored after reload");
await browser.close();
if (errors.length) console.log("console errors:\n" + errors.join("\n"));
