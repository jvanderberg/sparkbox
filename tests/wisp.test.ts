import { createConnection, createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { DailyCounter, mintToken, verifyToken } from "../server/tokens.ts";
import {
  CLOSE,
  CONNECT,
  CONTINUE,
  closeReasons,
  DATA,
  decode,
  decodeConnect,
  encode,
  hostAllowed,
  hostFromHttpRequest,
  type RelayOptions,
  serverNameFromClientHello,
  serveWisp,
} from "../server/wisp.ts";

describe("wisp framing", () => {
  it("round-trips packets and connect payloads", () => {
    const host = new TextEncoder().encode("registry.npmjs.org");
    const payload = new Uint8Array(3 + host.length);
    payload[0] = 1;
    new DataView(payload.buffer).setUint16(1, 443, true);
    payload.set(host, 3);
    const packet = encode(CONNECT, 7, payload);
    const decoded = decode(packet);
    expect(decoded.type).toBe(CONNECT);
    expect(decoded.streamId).toBe(7);
    expect(decodeConnect(decoded.payload)).toEqual({
      streamType: 1,
      port: 443,
      host: "registry.npmjs.org",
    });
  });
});

describe("destination detection", () => {
  it("reads the server name from a TLS ClientHello", () => {
    const name = new TextEncoder().encode("esm.sh");
    const sni = Buffer.concat([
      Buffer.from([0, 0, 0, name.length + 5, 0, name.length + 3, 0, 0, name.length]),
      Buffer.from(name),
    ]);
    const body = Buffer.concat([
      Buffer.from([3, 3]),
      Buffer.alloc(32, 1),
      Buffer.from([0]), // session id
      Buffer.from([0, 2, 0x13, 0x01]), // one cipher
      Buffer.from([1, 0]), // compression
      Buffer.from([0, sni.length]),
      sni,
    ]);
    const handshake = Buffer.concat([Buffer.from([1, 0, 0, body.length]), body]);
    const record = Buffer.concat([Buffer.from([0x16, 3, 1, 0, handshake.length]), handshake]);
    expect(serverNameFromClientHello(new Uint8Array(record))).toBe("esm.sh");
    expect(serverNameFromClientHello(new Uint8Array(record.subarray(0, 10)))).toBe("incomplete");
    expect(serverNameFromClientHello(new TextEncoder().encode("GET / HTTP/1.1\r\n"))).toBeNull();
  });
  it("reads the Host header from plain HTTP", () => {
    expect(
      hostFromHttpRequest(new TextEncoder().encode("GET / HTTP/1.1\r\nHost: Unpkg.com\r\n\r\n")),
    ).toBe("unpkg.com");
    expect(hostFromHttpRequest(new TextEncoder().encode("GET / HTTP/1.1\r\nHost: x"))).toBe(
      "incomplete",
    );
  });
  it("matches the allowlist with wildcards", () => {
    expect(hostAllowed("raw.githubusercontent.com", ["*.githubusercontent.com"])).toBe(true);
    expect(hostAllowed("githubusercontent.com", ["*.githubusercontent.com"])).toBe(true);
    expect(hostAllowed("evil.com", ["*.githubusercontent.com", "esm.sh"])).toBe(false);
  });
});

/** A fake WebSocket that records what the relay sends. */
function fakeSocket() {
  const handlers: Record<string, ((...args: never[]) => void)[]> = {};
  const sent: ReturnType<typeof decode>[] = [];
  const socket = {
    send(data: Uint8Array) {
      sent.push(decode(data));
    },
    close() {},
    on(event: string, listener: (...args: never[]) => void) {
      const list = handlers[event] ?? [];
      list.push(listener);
      handlers[event] = list;
    },
    message(packet: Uint8Array) {
      for (const h of handlers.message ?? [])
        (h as (data: Buffer, isBinary: boolean) => void)(Buffer.from(packet), true);
    },
    sent,
  };
  return socket;
}

function connectPacket(streamId: number, host: string, port = 80) {
  const name = new TextEncoder().encode(host);
  const payload = new Uint8Array(3 + name.length);
  payload[0] = 1;
  new DataView(payload.buffer).setUint16(1, port, true);
  payload.set(name, 3);
  return encode(CONNECT, streamId, payload);
}

const httpRequest = (host: string) =>
  new TextEncoder().encode(`GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`);

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("relay admission", () => {
  const relay = (socket: ReturnType<typeof fakeSocket>, options: Partial<RelayOptions> = {}) =>
    serveWisp(socket, {
      byteBudget: 1024 * 1024,
      resolve: async (host) => (host === "public.test" ? "203.0.113.9" : null),
      ...options,
    });

  it("refuses hosts the resolver calls private, unnamed streams and other ports", async () => {
    const socket = fakeSocket();
    relay(socket);
    socket.message(connectPacket(1, "10.0.0.1"));
    socket.message(encode(DATA, 1, httpRequest("10.0.0.1")));
    await until(() => socket.sent.some((p) => p.type === CLOSE && p.streamId === 1));
    const closed = socket.sent.find((p) => p.type === CLOSE && p.streamId === 1);
    expect(closed?.payload[0]).toBe(closeReasons.blocked);

    socket.message(connectPacket(2, "public.test", 443));
    socket.message(encode(DATA, 2, httpRequest("public.test"))); // not a ClientHello
    await until(() => socket.sent.some((p) => p.type === CLOSE && p.streamId === 2));
    expect(socket.sent.find((p) => p.type === CLOSE && p.streamId === 2)?.payload[0]).toBe(
      closeReasons.blocked,
    );

    socket.message(connectPacket(3, "public.test", 25));
    expect(socket.sent.find((p) => p.type === CLOSE && p.streamId === 3)?.payload[0]).toBe(
      closeReasons.blocked,
    );
  });

  it("honours an allowlist when one is set", async () => {
    const socket = fakeSocket();
    relay(socket, { allowlist: ["registry.npmjs.org"] });
    socket.message(connectPacket(1, "public.test"));
    socket.message(encode(DATA, 1, httpRequest("public.test")));
    await until(() => socket.sent.some((p) => p.type === CLOSE && p.streamId === 1));
    expect(socket.sent.find((p) => p.type === CLOSE)?.payload[0]).toBe(closeReasons.blocked);
  });

  it("caps streams per connection", () => {
    const socket = fakeSocket();
    relay(socket, { maxStreams: 2 });
    socket.message(connectPacket(1, "public.test"));
    socket.message(connectPacket(2, "public.test"));
    socket.message(connectPacket(3, "public.test"));
    const closed = socket.sent.filter((p) => p.type === CLOSE);
    expect(closed.map((p) => p.streamId)).toEqual([3]);
    expect(closed[0]?.payload[0]).toBe(closeReasons.throttled);
  });

  it("connects to the resolved address and relays bytes both ways", async () => {
    const server = createServer((connection) => {
      connection.on("data", (chunk) => connection.end(`echo:${chunk}`));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const dialed: string[] = [];
    const socket = fakeSocket();
    relay(socket, {
      connect: (address, _port, timeout) => {
        dialed.push(address);
        return createConnection({ host: "127.0.0.1", port, timeout });
      },
    });
    socket.message(connectPacket(1, "public.test"));
    socket.message(encode(DATA, 1, httpRequest("public.test")));
    await until(() => socket.sent.some((p) => p.type === DATA));
    expect(dialed).toEqual(["203.0.113.9"]);
    const data = socket.sent.find((p) => p.type === DATA);
    expect(new TextDecoder().decode(data?.payload)).toMatch(/^echo:GET \/ HTTP/);
    expect(socket.sent.filter((p) => p.type === CONTINUE).length).toBeGreaterThan(1);
    server.close();
  });
});

describe("tokens", () => {
  it("mints and verifies, rejecting tampering and other secrets", () => {
    const token = mintToken("s3cret");
    expect(verifyToken("s3cret", token)?.id).toBeTruthy();
    expect(verifyToken("other", token)).toBeNull();
    expect(verifyToken("s3cret", `${token}x`)).toBeNull();
    expect(verifyToken("s3cret", "a.b")).toBeNull();
  });
  it("keeps scoped tickets apart from invite tokens", () => {
    const invite = verifyToken("s3cret", mintToken("s3cret"));
    const ticket = mintToken("s3cret", 1, { scope: "relay", id: invite?.id });
    expect(verifyToken("s3cret", ticket, "relay")?.id).toBe(invite?.id);
    expect(verifyToken("s3cret", ticket)).toBeNull();
    expect(verifyToken("s3cret", mintToken("s3cret"), "relay")).toBeNull();
  });
  it("counts per day", () => {
    const counter = new DailyCounter();
    expect(counter.add("a")).toBe(1);
    expect(counter.add("a", 5)).toBe(6);
    expect(counter.get("b")).toBe(0);
  });
});
