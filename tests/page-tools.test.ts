import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewController } from "../src/agent/preview-controller.ts";
import { downloadTool, previewTool } from "../src/agent/tools.ts";
import { MemorySandbox } from "../src/sandbox/memory.ts";

afterEach(() => vi.unstubAllGlobals());

describe("download tool", () => {
  it("saves a fetched file under data/ by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("a,b\n1,2\n", { headers: { "content-type": "text/csv" } })),
    );
    const sandbox = new MemorySandbox();
    const result = await downloadTool(sandbox, { url: "https://data.example.org/stops.csv?x=1" });
    expect(result.error).toBeUndefined();
    expect(result.output).toMatch(/Saved data\/stops\.csv \(8 bytes, text\/csv\)/);
    expect(await sandbox.readText("data/stops.csv")).toBe("a,b\n1,2\n");
  });
  it("explains CORS failures and rejects bad URLs and escapes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const sandbox = new MemorySandbox();
    const blocked = await downloadTool(sandbox, { url: "https://blocked.example.org/a.json" });
    expect(blocked.error).toBe(true);
    expect(blocked.output).toMatch(/cross-origin|upload/);
    expect((await downloadTool(sandbox, { url: "ftp://x/y" })).error).toBe(true);
    expect((await downloadTool(sandbox, { url: "not a url" })).error).toBe(true);
    await expect(
      downloadTool(sandbox, { url: "https://ok.example.org/a.json", path: "../../etc/x" }),
    ).rejects.toThrow(/outside|escapes/);
  });
});

describe("preview tool", () => {
  function controller(): PreviewController & { requests: unknown[] } {
    const requests: unknown[] = [];
    return {
      requests,
      ensureRunning: async () => "http://localhost:4320/",
      recentErrors: () => ["TypeError: boom (/app.js:3)"],
      logs: () => "Serving /workspace on port 8080",
      configure: async (config) => ({
        command: config.command ?? "node .sparkbox/serve.mjs 8080 .",
        port: config.port ?? 8080,
        directory: config.directory ?? ".",
      }),
      status: () => ({
        config: { command: "node .sparkbox/serve.mjs 8080 .", port: 8080, directory: "." },
        running: true,
        url: "http://localhost:4320/",
      }),
      restart: async () => "http://localhost:4320/",
      query: async (request) => {
        requests.push(request);
        switch (request.format) {
          case "screenshot":
            return {
              format: "screenshot",
              image: "QUJD",
              mime: "image/jpeg",
              width: 390,
              height: 844,
              renderer: "test",
              images: { total: 3, loaded: 3 },
            };
          case "text":
            return { format: "text", text: "Title: App\n\nElements:\n# Hello" };
          case "html":
            return { format: "html", html: "<html></html>" };
          case "errors":
            return { format: "errors", errors: [] };
        }
      },
    };
  }
  it("returns images for screenshots and text for the other formats", async () => {
    const preview = controller();
    const shot = await previewTool(preview, {
      format: "screenshot",
      viewport: "phone",
      scheme: "dark",
    });
    expect(shot.image?.data).toBe("QUJD");
    expect(shot.output).toMatch(/phone size \(390x844\), dark scheme \(forced\)/);
    expect(preview.requests[0]).toMatchObject({
      format: "screenshot",
      viewport: "phone",
      path: "/",
    });
    const text = await previewTool(preview, { format: "text" });
    expect(text.output).toContain("# Hello");
    const errors = await previewTool(preview, { format: "errors", viewport: "desktop" });
    expect(errors.output).toContain("fresh load of / at desktop size: none");
    expect(errors.output).toContain("TypeError: boom");
  });
  it("reports status, logs and configure results", async () => {
    const preview = controller();
    expect((await previewTool(preview, { format: "status" })).output).toMatch(
      /running at http:\/\/localhost:4320\/.*port 8080/,
    );
    expect((await previewTool(preview, { format: "logs" })).output).toContain("Serving /workspace");
    const configured = await previewTool(preview, {
      format: "configure",
      command: "npm run dev",
      port: 5173,
    });
    expect(configured.error).toBeUndefined();
    expect(configured.output).toContain("Saved sparkbox.json");
    expect((await previewTool(preview, { format: "configure" })).error).toBe(true);
  });
  it("fails clearly without a controller", async () => {
    const result = await previewTool(undefined, { format: "text" });
    expect(result.error).toBe(true);
  });
});
