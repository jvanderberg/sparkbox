import { describe, expect, it } from "vitest";
import { DailyCounter, mintToken, verifyToken } from "../server/tokens.ts";
import {
  CONNECT,
  decode,
  decodeConnect,
  encode,
  hostAllowed,
  hostFromHttpRequest,
  serverNameFromClientHello,
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

describe("tokens", () => {
  it("mints and verifies, rejecting tampering and other secrets", () => {
    const token = mintToken("s3cret");
    expect(verifyToken("s3cret", token)?.id).toBeTruthy();
    expect(verifyToken("other", token)).toBeNull();
    expect(verifyToken("s3cret", `${token}x`)).toBeNull();
    expect(verifyToken("s3cret", "a.b")).toBeNull();
  });
  it("counts per day", () => {
    const counter = new DailyCounter();
    expect(counter.add("a")).toBe(1);
    expect(counter.add("a", 5)).toBe(6);
    expect(counter.get("b")).toBe(0);
  });
});
