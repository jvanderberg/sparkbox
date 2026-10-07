/**
 * WISP v1 relay: multiplexes TCP streams over one WebSocket.
 *
 * Packet: [u8 type][u32 LE stream id][payload]
 *   0x01 CONNECT  [u8 stream type (1 tcp, 2 udp)][u16 LE port][hostname]
 *   0x02 DATA     bytes
 *   0x03 CONTINUE [u32 LE buffer remaining]   (server → client flow control)
 *   0x04 CLOSE    [u8 reason]
 *
 * The sandbox resolves names itself and may CONNECT by IP, so the allowlist
 * is enforced on what the stream says it is talking to: the TLS server name
 * on 443 and the Host header on 80. Anything else is refused.
 */
import { createConnection, type Socket } from "node:net";

export const CONNECT = 0x01;
export const DATA = 0x02;
export const CONTINUE = 0x03;
export const CLOSE = 0x04;

export const closeReasons = {
  unspecified: 0x01,
  voluntary: 0x02,
  networkError: 0x03,
  blocked: 0x41,
  throttled: 0x42,
  refused: 0x43,
  timeout: 0x44,
  unreachable: 0x45,
} as const;

export const bufferSize = 128;

export function encode(type: number, streamId: number, payload: Uint8Array = new Uint8Array()) {
  const packet = new Uint8Array(5 + payload.length);
  packet[0] = type;
  new DataView(packet.buffer).setUint32(1, streamId, true);
  packet.set(payload, 5);
  return packet;
}

export function decode(packet: Uint8Array) {
  if (packet.length < 5) throw new Error("short packet");
  return {
    type: packet[0] as number,
    streamId: new DataView(packet.buffer, packet.byteOffset).getUint32(1, true),
    payload: packet.subarray(5),
  };
}

export function decodeConnect(payload: Uint8Array) {
  if (payload.length < 3) throw new Error("short connect");
  const view = new DataView(payload.buffer, payload.byteOffset);
  return {
    streamType: payload[0] as number,
    port: view.getUint16(1, true),
    host: new TextDecoder().decode(payload.subarray(3)),
  };
}

export function continuePacket(streamId: number, remaining: number) {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, remaining, true);
  return encode(CONTINUE, streamId, payload);
}

export function closePacket(streamId: number, reason: number) {
  return encode(CLOSE, streamId, new Uint8Array([reason]));
}

/** The server name from a TLS ClientHello, or null when not (yet) parseable. */
export function serverNameFromClientHello(data: Uint8Array): string | null | "incomplete" {
  if (data.length < 5) return "incomplete";
  if (data[0] !== 0x16) return null; // not a TLS handshake record
  const recordLength = ((data[3] as number) << 8) | (data[4] as number);
  if (data.length < 5 + recordLength) return "incomplete";
  let at = 5;
  if (data[at] !== 0x01) return null; // not ClientHello
  at += 4; // handshake type + length
  at += 2 + 32; // version + random
  const sessionIdLength = data[at] as number;
  at += 1 + sessionIdLength;
  const cipherLength = ((data[at] as number) << 8) | (data[at + 1] as number);
  at += 2 + cipherLength;
  const compressionLength = data[at] as number;
  at += 1 + compressionLength;
  if (at + 2 > data.length) return null;
  const extensionsLength = ((data[at] as number) << 8) | (data[at + 1] as number);
  at += 2;
  const end = Math.min(data.length, at + extensionsLength);
  while (at + 4 <= end) {
    const type = ((data[at] as number) << 8) | (data[at + 1] as number);
    const length = ((data[at + 2] as number) << 8) | (data[at + 3] as number);
    at += 4;
    if (type === 0) {
      // server_name: list length (2), name type (1), name length (2), name
      const nameLength = ((data[at + 3] as number) << 8) | (data[at + 4] as number);
      return new TextDecoder().decode(data.subarray(at + 5, at + 5 + nameLength)).toLowerCase();
    }
    at += length;
  }
  return null;
}

/** The Host header from the start of a plain HTTP request. */
export function hostFromHttpRequest(data: Uint8Array): string | null | "incomplete" {
  const text = new TextDecoder().decode(data.subarray(0, 8192));
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return data.length >= 8192 ? null : "incomplete";
  const match = /\r\nhost:\s*([^\r\n:]+)/i.exec(text.slice(0, headerEnd));
  return match?.[1]?.trim().toLowerCase() ?? null;
}

export function hostAllowed(host: string, allowlist: string[]) {
  return allowlist.some((pattern) =>
    pattern.startsWith("*.")
      ? host === pattern.slice(2) || host.endsWith(pattern.slice(1))
      : host === pattern,
  );
}

export type RelayOptions = {
  allowlist: string[];
  /** Bytes this connection may relay in total (both directions). */
  byteBudget: number;
  onBytes?: (count: number) => void;
  connectTimeoutMs?: number;
  log?: (message: string) => void;
};

type WebSocketLike = {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(
    event: "message",
    listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void,
  ): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

/** Attach the relay to an accepted WebSocket. */
export function serveWisp(socket: WebSocketLike, options: RelayOptions) {
  const log = options.log ?? (() => {});
  const streams = new Map<
    number,
    { socket: Socket | null; pending: Uint8Array[]; connected: boolean }
  >();
  const targets = new Map<number, { host: string; port: number }>();
  let relayed = 0;
  const send = (packet: Uint8Array) => {
    try {
      socket.send(packet);
    } catch {
      // The socket closed under us; the close handler cleans up.
    }
  };
  const account = (count: number) => {
    relayed += count;
    options.onBytes?.(count);
    if (relayed > options.byteBudget) {
      log("byte budget exhausted");
      socket.close(1008, "byte budget exhausted");
    }
  };
  const closeStream = (streamId: number, reason: number, notify = true) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    stream.socket?.destroy();
    if (notify) send(closePacket(streamId, reason));
  };

  const open = (streamId: number, host: string, port: number) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    const target = createConnection({ host, port, timeout: options.connectTimeoutMs ?? 15_000 });
    stream.socket = target;
    target.once("connect", () => {
      stream.connected = true;
      for (const chunk of stream.pending) target.write(chunk);
      stream.pending = [];
      send(continuePacket(streamId, bufferSize));
    });
    target.on("data", (chunk: Buffer) => {
      account(chunk.length);
      send(encode(DATA, streamId, new Uint8Array(chunk)));
    });
    target.on("timeout", () => closeStream(streamId, closeReasons.timeout));
    target.on("error", (error: NodeJS.ErrnoException) => {
      const reason =
        error.code === "ECONNREFUSED"
          ? closeReasons.refused
          : error.code === "ENOTFOUND" || error.code === "EHOSTUNREACH"
            ? closeReasons.unreachable
            : closeReasons.networkError;
      closeStream(streamId, reason);
    });
    target.on("close", () => closeStream(streamId, closeReasons.voluntary));
  };

  socket.on("message", (raw, isBinary) => {
    if (!isBinary) return;
    const buffer = Array.isArray(raw)
      ? Buffer.concat(raw)
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : raw;
    let packet: ReturnType<typeof decode>;
    try {
      packet = decode(new Uint8Array(buffer));
    } catch {
      return;
    }
    const { type, streamId, payload } = packet;
    if (type === CONNECT) {
      let connect: ReturnType<typeof decodeConnect>;
      try {
        connect = decodeConnect(payload);
      } catch {
        return send(closePacket(streamId, closeReasons.unspecified));
      }
      if (connect.streamType !== 1 || (connect.port !== 443 && connect.port !== 80)) {
        log(`refused ${connect.streamType === 1 ? "tcp" : "udp"} ${connect.host}:${connect.port}`);
        return send(closePacket(streamId, closeReasons.blocked));
      }
      // Hold the connection until the first bytes reveal the real destination.
      streams.set(streamId, { socket: null, pending: [], connected: false });
      // Store the requested target on the stream record for the data phase.
      targets.set(streamId, { host: connect.host, port: connect.port });
      send(continuePacket(streamId, bufferSize));
      return;
    }
    if (type === DATA) {
      const stream = streams.get(streamId);
      const target = targets.get(streamId);
      if (!stream || !target) return;
      account(payload.length);
      if (stream.connected && stream.socket) {
        stream.socket.write(payload, () => send(continuePacket(streamId, bufferSize)));
        return;
      }
      stream.pending.push(new Uint8Array(payload));
      if (stream.socket) return; // connecting; data queued
      const head = Buffer.concat(stream.pending);
      const name =
        target.port === 443 ? serverNameFromClientHello(head) : hostFromHttpRequest(head);
      if (name === "incomplete") {
        if (head.length > 16_384) closeStream(streamId, closeReasons.blocked);
        return;
      }
      if (!name || !hostAllowed(name, options.allowlist)) {
        log(`blocked ${name ?? "(unknown)"}:${target.port}`);
        closeStream(streamId, closeReasons.blocked);
        return;
      }
      // Connect to the name the client actually spoke to, not the raw target,
      // so an IP from the sandbox's own DNS cannot point the allowlisted name elsewhere.
      open(streamId, name, target.port);
      return;
    }
    if (type === CLOSE) {
      closeStream(streamId, closeReasons.voluntary, false);
      targets.delete(streamId);
    }
  });
  socket.on("close", () => {
    for (const streamId of [...streams.keys()])
      closeStream(streamId, closeReasons.voluntary, false);
    targets.clear();
  });
  socket.on("error", () => {
    for (const streamId of [...streams.keys()])
      closeStream(streamId, closeReasons.voluntary, false);
  });
  // Initial flow-control window.
  send(continuePacket(0, bufferSize));
}

export const defaultAllowlist = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "*.npmjs.org",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "esm.sh",
  "cdn.jsdelivr.net",
  "data.jsdelivr.com",
  "unpkg.com",
  "cdn.tailwindcss.com",
  "pypi.org",
  "files.pythonhosted.org",
  "python-registry.wasmer.app",
  "registry.wasmer.io",
  "deno.land",
  "jsr.io",
  "crates.io",
  "static.crates.io",
];
