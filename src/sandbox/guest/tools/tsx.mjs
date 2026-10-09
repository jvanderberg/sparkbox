// The first half of `tsx FILE [ARGS]`: the sandbox's Node cannot strip
// TypeScript types, so this asks the page (through the bridge the git
// command uses) to bundle FILE with esbuild, and prints the bundle's path.
// The bash wrapper then runs the bundle with Node.
import net from "node:net";
import { err, exit, fail, out } from "./io.mjs";

const port = Number("__BRIDGE_PORT__");
const [file] = process.argv.slice(2);
if (!file || file.startsWith("-"))
  fail(
    "usage: tsx FILE [ARGS...]\nRuns a TypeScript or JavaScript file. Options are not supported.",
  );

// The bridge may still be starting in a fresh session; retry for a while.
const deadline = Date.now() + 15_000;
function attempt() {
  let connected = false;
  let buffer = "";
  const socket = net.connect(port, "127.0.0.1");
  socket.on("connect", () => {
    connected = true;
    socket.write(`${JSON.stringify({ tool: "bundle", argv: [file], cwd: process.cwd() })}\n`);
  });
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const reply = JSON.parse(buffer.slice(0, newline));
    socket.end();
    if (reply.stderr) err(reply.stderr);
    if (reply.stdout) out(reply.stdout);
    exit(reply.code ?? 1);
  });
  socket.on("error", () => {
    if (!connected && Date.now() < deadline) setTimeout(attempt, 250);
    else fail("the Sparkbox bridge is not running; try again in a moment");
  });
}
attempt();
