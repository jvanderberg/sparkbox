/**
 * WebSocket bridge that runs inside the sandbox (Node via Edge.js). The
 * preview channel is HTTP-only, so pages reach guest WebSocket servers
 * (Vite HMR, app sockets) through this process instead: the page's shim
 * posts frames to the Sparkbox tab, which pipes them here as JSON lines on
 * stdin; this script holds the real sockets and answers on stdout.
 *
 * stdin  → {"op":"open","id":1,"port":5173,"path":"/","protocols":["vite-hmr"]}
 *          {"op":"send","id":1,"text":"..."} | {"op":"send","id":1,"base64":"..."}
 *          {"op":"close","id":1,"code":1000,"reason":""}
 * stdout → {"op":"open","id":1,"protocol":"vite-hmr"}
 *          {"op":"message","id":1,"text":"..."} | {"op":"message","id":1,"base64":"..."}
 *          {"op":"close","id":1,"code":1006,"reason":"..."} | {"op":"error","id":1,"message":"..."}
 */
export const wsBridgeScript = `import net from "node:net";
import crypto from "node:crypto";
import readline from "node:readline";

const sockets = new Map();
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

function frame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function open(message) {
  const { id, port, path, protocols } = message;
  const key = crypto.randomBytes(16).toString("base64");
  const socket = net.connect(port, "127.0.0.1");
  const state = { socket, buffer: Buffer.alloc(0), upgraded: false, fragments: [], fragmentOpcode: 0 };
  sockets.set(id, state);
  socket.on("connect", () => {
    socket.write(
      "GET " + (path || "/") + " HTTP/1.1\\r\\n" +
        "Host: 127.0.0.1:" + port + "\\r\\n" +
        "Upgrade: websocket\\r\\nConnection: Upgrade\\r\\n" +
        "Sec-WebSocket-Key: " + key + "\\r\\nSec-WebSocket-Version: 13\\r\\n" +
        (protocols && protocols.length ? "Sec-WebSocket-Protocol: " + protocols.join(", ") + "\\r\\n" : "") +
        "\\r\\n",
    );
  });
  socket.on("data", (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    if (!state.upgraded) {
      const end = state.buffer.indexOf("\\r\\n\\r\\n");
      if (end < 0) return;
      const head = state.buffer.subarray(0, end).toString();
      state.buffer = state.buffer.subarray(end + 4);
      if (!/^HTTP\\/1\\.1 101/.test(head)) {
        out({ op: "error", id, message: "upgrade refused: " + head.split("\\r\\n")[0] });
        socket.destroy();
        return;
      }
      const protocol = /sec-websocket-protocol:\\s*([^\\r\\n]+)/i.exec(head);
      state.upgraded = true;
      out({ op: "open", id, protocol: protocol ? protocol[1].trim() : "" });
    }
    parseFrames(id, state);
  });
  socket.on("error", (error) => out({ op: "error", id, message: error.message }));
  socket.on("close", () => {
    if (sockets.delete(id)) out({ op: "close", id, code: 1006, reason: "" });
  });
}

function parseFrames(id, state) {
  while (true) {
    const buffer = state.buffer;
    if (buffer.length < 2) return;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return;
    let payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    state.buffer = buffer.subarray(offset + length);
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString() : "";
      sockets.delete(id);
      out({ op: "close", id, code, reason });
      state.socket.end(frame(0x8, payload));
      return;
    }
    if (opcode === 0x9) {
      state.socket.write(frame(0xa, payload));
      continue;
    }
    if (opcode === 0xa) continue;
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (opcode !== 0x0) state.fragmentOpcode = opcode;
      state.fragments.push(payload);
      if (!fin) continue;
      const whole = Buffer.concat(state.fragments);
      state.fragments = [];
      if (state.fragmentOpcode === 0x1) out({ op: "message", id, text: whole.toString("utf8") });
      else out({ op: "message", id, base64: whole.toString("base64") });
    }
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.op === "open") return open(message);
  const state = sockets.get(message.id);
  if (!state || !state.upgraded) return;
  if (message.op === "send") {
    if (typeof message.text === "string") state.socket.write(frame(0x1, Buffer.from(message.text, "utf8")));
    else if (typeof message.base64 === "string") state.socket.write(frame(0x2, Buffer.from(message.base64, "base64")));
  } else if (message.op === "close") {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(message.code || 1000, 0);
    state.socket.end(frame(0x8, Buffer.concat([payload, Buffer.from(message.reason || "")])));
  }
});
process.stdin.on("end", () => {
  for (const state of sockets.values()) state.socket.destroy();
  process.exit(0);
});
out({ op: "ready" });
`;
