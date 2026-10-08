import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BodyTooLargeError, readBody } from "../server/body.ts";

describe("readBody", () => {
  let server: Server;
  let origin = "";
  beforeAll(async () => {
    server = createServer((request, response) => {
      readBody(request, 1024)
        .then((body) => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end(String(body.length));
        })
        .catch((error: unknown) => {
          const status = error instanceof BodyTooLargeError ? 413 : 500;
          response.writeHead(status, { "content-type": "text/plain" });
          response.end(error instanceof Error ? error.message : "error");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("returns the body when it fits", async () => {
    const response = await fetch(origin, { method: "POST", body: "x".repeat(1000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1000");
  });

  it("answers an oversized body with the refusal instead of dropping the connection", async () => {
    // Before this, the socket was destroyed mid-upload; the client (and Fly's
    // proxy in front of the host) saw a closed connection and no response.
    const response = await fetch(origin, { method: "POST", body: "x".repeat(3 * 1024 * 1024) });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("body larger than 1024 bytes");
  });
});
