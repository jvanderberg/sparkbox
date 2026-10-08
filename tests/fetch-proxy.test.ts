import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FETCH_PROXY_LIMIT,
  isPrivateAddress,
  proxyTarget,
  serveFetchProxy,
} from "../server/fetch-proxy.ts";

describe("isPrivateAddress", () => {
  it("refuses loopback, private, link-local and unspecified ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
  });
  it("accepts public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("proxyTarget", () => {
  it("accepts http(s) URLs to public hosts", () => {
    const target = proxyTarget("https://data.example.org/a.json?key=1");
    expect("url" in target && target.url.href).toBe("https://data.example.org/a.json?key=1");
  });
  it("rejects bad schemes, credentials and local hosts before any network access", () => {
    for (const raw of [
      null,
      "",
      "not a url",
      "ftp://x/y",
      "file:///etc/passwd",
      "https://user:pw@example.org/",
      "http://localhost:4330/healthz",
      "http://app.localhost/",
      "http://printer.local/",
      "http://db.internal/",
      "http://127.0.0.1:4330/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      const target = proxyTarget(raw);
      expect("error" in target, String(raw)).toBe(true);
    }
  });
});

describe("serveFetchProxy", () => {
  let upstream: Server;
  let base = "";
  let proxy: Server;
  let proxyBase = "";
  const bytes: number[] = [];
  const logs: string[] = [];
  let budget = FETCH_PROXY_LIMIT;

  beforeAll(async () => {
    upstream = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://x");
      if (url.pathname === "/data.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            q: url.searchParams.get("key"),
            cookie: request.headers.cookie ?? null,
          }),
        );
      } else if (url.pathname === "/redirect") {
        response.writeHead(302, { location: "/data.json?key=r" });
        response.end();
      } else if (url.pathname === "/redirect-private") {
        response.writeHead(302, { location: "http://169.254.169.254/latest" });
        response.end();
      } else if (url.pathname === "/big") {
        response.writeHead(200, { "content-length": String(FETCH_PROXY_LIMIT + 1) });
        response.end();
      } else {
        response.writeHead(404);
        response.end("nope");
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    proxy = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://x");
      void serveFetchProxy(request, response, url.searchParams.get("url"), {
        byteBudget: budget,
        onBytes: (count) => bytes.push(count),
        log: (message) => logs.push(message),
        headers: { "x-test": "1" },
        exemptHosts: ["127.0.0.1"],
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => proxy.close(resolve));
  });

  const call = (target: string, init?: RequestInit) =>
    fetch(`${proxyBase}/api/fetch?url=${encodeURIComponent(target)}`, init);

  it("streams the upstream body and headers without forwarding cookies", async () => {
    const response = await call(`${base}/data.json?key=secret`, { headers: { cookie: "a=b" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-test")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ q: "secret", cookie: null });
    expect(bytes.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    // Logged by host and status only; the query string with the key never appears.
    expect(logs.join("\n")).toMatch(/fetch 127\.0\.0\.1: 200/);
    expect(logs.join("\n")).not.toMatch(/secret|data\.json/);
  });
  it("follows same-site redirects and refuses redirects to private hosts", async () => {
    const followed = await call(`${base}/redirect`);
    expect(followed.status).toBe(200);
    expect(await followed.json()).toEqual({ q: "r", cookie: null });
    const refused = await call(`${base}/redirect-private`);
    expect(refused.status).toBe(403);
  });
  it("passes upstream errors through and rejects oversized files", async () => {
    expect((await call(`${base}/missing`)).status).toBe(404);
    const big = await call(`${base}/big`);
    expect(big.status).toBe(413);
  });
  it("rejects non-GET methods, invalid URLs and an exhausted budget", async () => {
    expect((await call(`${base}/data.json`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${proxyBase}/api/fetch?url=ftp://x/y`)).status).toBe(400);
    budget = 0;
    expect((await call(`${base}/data.json`)).status).toBe(429);
    budget = FETCH_PROXY_LIMIT;
  });
});
