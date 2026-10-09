/**
 * The `git` command inside the sandbox. The repository is kept by the page
 * (isomorphic-git), so the command only carries its arguments there and
 * prints the answer: a bash wrapper on the PATH runs the shim, the shim
 * connects to the bridge process on a loopback port, and the bridge, whose
 * stdio the page owns, relays JSON lines both ways.
 *
 * shim → bridge:  {"id":1,"argv":["status"],"cwd":"/workspace/src"}
 * bridge → page:  the same line on stdout
 * page → bridge:  {"id":1,"stdout":"...","stderr":"...","code":0} on stdin
 * bridge → shim:  the same line back on the socket
 *
 * Other page-backed commands use the same bridge with a `tool` field (the
 * tsx command asks the page to bundle a TypeScript file).
 */
export const gitBridgePort = 4998;
export const gitBridgePath = ".sparkbox/git-bridge.mjs";
export const gitShimPath = ".sparkbox/git.mjs";
export const gitWrapperPath = ".sparkbox/bin/git";

export const gitWrapperScript = `#!/bin/bash
exec node /workspace/${gitShimPath} "$@"
`;

// The bridge may still be starting when the first command runs (a fresh
// session, or its restart after a runtime rebuild), so a refused connection
// is retried for a while before git reports itself unavailable.
export const gitShimScript = `import net from "node:net";
const deadline = Date.now() + 15000;
let buffer = "";
function attempt() {
  let connected = false;
  const socket = net.connect(${gitBridgePort}, "127.0.0.1");
  socket.on("connect", () => {
    connected = true;
    socket.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
  });
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const reply = JSON.parse(buffer.slice(0, newline));
    if (reply.stdout) process.stdout.write(reply.stdout);
    if (reply.stderr) process.stderr.write(reply.stderr);
    socket.end();
    process.exitCode = reply.code ?? 1;
  });
  socket.on("error", () => {
    if (!connected && Date.now() < deadline) {
      setTimeout(attempt, 250);
      return;
    }
    process.stderr.write("fatal: git is not available right now (the Sparkbox git bridge is not running). Try again in a moment.\\n");
    process.exitCode = 128;
  });
}
attempt();
`;

export const gitBridgeScript = `import net from "node:net";
import readline from "node:readline";

let next = 1;
const waiting = new Map();
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    let request;
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      socket.end(JSON.stringify({ stderr: "bad request\\n", code: 1 }) + "\\n");
      return;
    }
    const id = next++;
    waiting.set(id, socket);
    out({ id, tool: request.tool, argv: request.argv ?? [], cwd: request.cwd ?? "" });
  });
  socket.on("error", () => {});
});
server.listen(${gitBridgePort}, "127.0.0.1");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    return;
  }
  const socket = waiting.get(reply.id);
  if (!socket) return;
  waiting.delete(reply.id);
  socket.end(JSON.stringify(reply) + "\\n");
});
`;
