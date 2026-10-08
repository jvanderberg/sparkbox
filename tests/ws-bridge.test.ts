import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { wsBridgeScript } from "../src/sandbox/ws-bridge-script.ts";

let server: WebSocketServer;
let port = 0;
beforeAll(async () => {
  server = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary)
        socket.send(Buffer.concat([Buffer.from("bin:"), data as Buffer]), { binary: true });
      else socket.send(`echo:${data.toString()}`);
    });
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe("ws bridge script", () => {
  it("opens, echoes text and binary, and closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sparkbox-ws-"));
    const file = join(dir, "bridge.mjs");
    writeFileSync(file, wsBridgeScript);
    const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "inherit"] });
    const lines: Record<string, unknown>[] = [];
    const waiters: ((line: Record<string, unknown>) => void)[] = [];
    createInterface({ input: child.stdout }).on("line", (line) => {
      const parsed = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else lines.push(parsed);
    });
    const next = () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const queued = lines.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    expect(await next()).toEqual({ op: "ready" });
    send({ op: "open", id: 1, port, path: "/", protocols: ["vite-hmr"] });
    expect(await next()).toEqual({ op: "open", id: 1, protocol: "vite-hmr" });
    send({ op: "send", id: 1, text: "hello" });
    expect(await next()).toEqual({ op: "message", id: 1, text: "echo:hello" });
    send({ op: "send", id: 1, base64: Buffer.from([1, 2, 3]).toString("base64") });
    const binary = await next();
    expect(Buffer.from(String(binary.base64), "base64")).toEqual(
      Buffer.concat([Buffer.from("bin:"), Buffer.from([1, 2, 3])]),
    );
    const big = "x".repeat(70_000);
    send({ op: "send", id: 1, text: big });
    expect((await next()).text).toBe(`echo:${big}`);
    send({ op: "close", id: 1, code: 1000, reason: "done" });
    expect(await next()).toMatchObject({ op: "close", id: 1, code: 1000 });
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  });
  it("reports refused connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sparkbox-ws-"));
    const file = join(dir, "bridge.mjs");
    writeFileSync(file, wsBridgeScript);
    const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "inherit"] });
    const output: string[] = [];
    createInterface({ input: child.stdout }).on("line", (line) => output.push(line));
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.write(`${JSON.stringify({ op: "open", id: 2, port: 1, path: "/" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.stdin.end();
    expect(
      output.some((line) => line.includes('"op":"error"') || line.includes('"op":"close"')),
    ).toBe(true);
  });
});
