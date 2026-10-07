/**
 * Manual check of the agent's preview tool against a Leaflet map with
 * polylines: renders the tool's phone screenshots in both schemes and a
 * native capture of the same served page into artifacts/ for comparison.
 *
 *   npm run dev    (in another terminal)
 *   npx tsx scripts/preview-tool-check.ts
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.SPARKBOX_URL ?? "http://127.0.0.1:4320";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  colorScheme: "light",
});
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "warning" || message.type() === "error")
    console.log(`[${message.type()}]`, message.text().slice(0, 300));
});
await page.goto(base);
await page.getByLabel("New project name").fill("Lines");
await page.getByRole("button", { name: "Create" }).click();
await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 240_000 });
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin>
<style>:root{color-scheme:light dark}body{margin:0;font-family:system-ui;background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}#map{height:70vh}h1{margin:8px;font-size:18px}</style></head>
<body><h1>Lines test</h1><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin></script>
<script>const map=L.map('map').setView([41.885,-87.785],13);L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{crossOrigin:true}).addTo(map);
L.polyline([[41.8884,-87.8050],[41.8884,-87.7700]],{color:'green',weight:6}).addTo(map);L.polyline([[41.8710,-87.8050],[41.8710,-87.7700]],{color:'blue',weight:6}).addTo(map);</script></body></html>`;
await page.locator("nav.workspace-tabs").getByRole("button", { name: "Files" }).click();
await page
  .locator('input[type="file"][id^="workspace-upload-"]')
  .setInputFiles({ name: "index.html", mimeType: "text/html", buffer: Buffer.from(html) });
await page.waitForTimeout(1500);
type Tool = (request: unknown) => Promise<{ image: string; renderer: string; images: unknown }>;
for (const [index, scheme] of (["light", "light", "dark"] as const).entries()) {
  const shot = await page.evaluate(
    (scheme) =>
      (window as unknown as { sparkboxPreviewTool: Tool }).sparkboxPreviewTool({
        format: "screenshot",
        viewport: "phone",
        scheme,
      }),
    scheme,
  );
  writeFileSync(`artifacts/lines-tool-${index}-${scheme}.jpg`, Buffer.from(shot.image, "base64"));
  console.log(scheme, "renderer:", shot.renderer, "images:", JSON.stringify(shot.images));
}
const direct = await context.newPage();
await direct.goto(new URL("/#sparkbox-probe", base.replace("127.0.0.1", "localhost")).href);
await direct.waitForTimeout(4000);
await direct.screenshot({ path: "artifacts/lines-native-light.png" });
await browser.close();
console.log("wrote artifacts/lines-tool-<n>-<scheme>.jpg and artifacts/lines-native-light.png");
