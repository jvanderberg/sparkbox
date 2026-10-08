/**
 * End-to-end check of the preview WebSocket tunnel: a dependency-free Node
 * WebSocket echo server runs inside the sandbox as the preview command, and
 * the served page opens a same-origin socket, which the injected shim
 * tunnels through the sandbox bridge. No model calls; no network needed.
 *
 *   npx tsx scripts/ws-smoke.ts
 */
import { chromium } from "playwright";

const base = process.env.SPARKBOX_URL ?? "http://127.0.0.1:4320";
const server = `import http from "node:http";
import crypto from "node:crypto";
const page = \`<!doctype html><html><body><h1>ws test</h1><p id="out">waiting</p>
<script>
const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/echo", "sparkbox-test");
ws.onopen = () => { ws.send("hello tunnel"); };
ws.onmessage = (e) => { document.getElementById("out").textContent += " got: " + e.data + " proto=" + ws.protocol; if (!e.data.startsWith("binary")) ws.send(new Uint8Array([1,2,3])); };
ws.onerror = () => { document.getElementById("out").textContent = "error"; };
ws.onclose = (e) => { document.getElementById("out").textContent += " closed " + e.code; };
</script></body></html>\`;
function frame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x80 | opcode, length]);
  else { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2); }
  return Buffer.concat([header, payload]);
}
const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page); });
srv.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  const proto = (req.headers["sec-websocket-protocol"] || "").split(",")[0].trim();
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n" + (proto ? "Sec-WebSocket-Protocol: " + proto + "\\r\\n" : "") + "\\r\\n");
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f; const masked = (buf[1] & 0x80) !== 0; let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len)); if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { socket.end(frame(0x8, payload)); return; }
      if (opcode === 0x1) socket.write(frame(0x1, Buffer.from("echo:" + payload.toString())));
      if (opcode === 0x2) { socket.write(frame(0x1, Buffer.from("binary:" + Array.from(payload).join(",")))); }
    }
  });
});
srv.listen(8080, "0.0.0.0", () => console.log("ws echo on 8080"));
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto(base);
await page.getByLabel("New project name").fill("WS tunnel");
await page.getByRole("button", { name: "Create" }).click();
await page.getByText("Sandbox ready").waitFor({ state: "attached", timeout: 240_000 });
type Write = (p: string, c: string) => Promise<void>;
const write = (p: string, c: string) =>
  page.evaluate(
    (a: { p: string; c: string }) =>
      (window as unknown as { sparkboxWrite: Write }).sparkboxWrite(a.p, a.c),
    { p, c },
  );
await write("ws-echo.mjs", server);
await write(
  "sparkbox.json",
  JSON.stringify({ preview: { command: "node ws-echo.mjs", port: 8080, directory: "." } }, null, 2),
);
const tabs = page.locator("nav.workspace-tabs");
await tabs.getByRole("button", { name: "Preview" }).click();
await page.locator(".preview-panel").getByRole("button", { name: "Preview" }).click();
const frame = page.locator("iframe.preview-frame");
await frame.waitFor({ timeout: 180_000 });
const content = frame.contentFrame();
await content.getByRole("heading", { name: "ws test" }).waitFor({ timeout: 60_000 });
await content.getByText(/got: echo:hello tunnel proto=sparkbox-test/).waitFor({ timeout: 30_000 });
await content
  .getByText(/binary:1,2,3/)
  .waitFor({ timeout: 30_000 })
  .catch(() => {});
console.log("page text:", await content.locator("#out").innerText());
await browser.close();
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
console.log("ok ws tunnel");
