import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const curlTool = path.resolve("src/sandbox/guest/tools/curl.mjs");
const wgetTool = path.resolve("src/sandbox/guest/tools/wget.mjs");
const binary = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 37) % 256));

let server: Server;
let base = "";
const roots: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      switch (url.pathname) {
        case "/hello.txt":
          res.writeHead(200, { "content-type": "text/plain", "x-test": "yes" });
          res.end("hello world\n");
          return;
        case "/echo":
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ method: req.method, query: url.search, headers: req.headers, body }),
          );
          return;
        case "/redirect": {
          // /redirect?n=2 -> /redirect?n=1 -> /hello.txt
          const n = Number(url.searchParams.get("n") ?? "1");
          const next = n > 1 ? `/redirect?n=${n - 1}` : "/hello.txt";
          res.writeHead(302, { location: next, "content-type": "text/plain" });
          res.end("moved\n");
          return;
        }
        case "/post-redirect":
          res.writeHead(302, { location: "/echo" });
          res.end();
          return;
        case "/bin/data.bin":
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(binary);
          return;
        case "/slow":
          setTimeout(() => res.end("late\n"), 5000);
          return;
        case "/dir/":
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<p>index</p>\n");
          return;
        default:
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("no such page\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "sparkbox-curl-"));
  roots.push(dir);
  return dir;
}

type Result = { stdout: Buffer; out: string; err: string; code: number | null };

// Async spawn: a synchronous one would block the event loop that serves the requests.
function run(tool: string, args: string[], cwd = tempDir(), input = ""): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tool, ...args], { cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const all = Buffer.concat(stdout);
      resolve({ stdout: all, out: all.toString(), err: Buffer.concat(stderr).toString(), code });
    });
    child.stdin.end(input);
  });
}

const curl = (args: string[], cwd?: string, input?: string) => run(curlTool, args, cwd, input);
const wget = (args: string[], cwd?: string) => run(wgetTool, args, cwd);
const echoed = (result: Result) =>
  JSON.parse(result.out) as {
    method: string;
    query: string;
    headers: Record<string, string>;
    body: string;
  };

describe("curl", () => {
  it("prints the body of a GET to stdout", async () => {
    expect(await curl([`${base}/hello.txt`])).toMatchObject({
      out: "hello world\n",
      err: "",
      code: 0,
    });
  });

  it("writes to -o and -O files, with --output-dir and --create-dirs", async () => {
    const dir = tempDir();
    const result = await curl(
      ["-s", `${base}/hello.txt`, "-ocopy.txt", `${base}/bin/data.bin`, "-O"],
      dir,
    );
    expect(result).toMatchObject({ out: "", code: 0 });
    expect(readFileSync(path.join(dir, "copy.txt"), "utf8")).toBe("hello world\n");
    expect(readFileSync(path.join(dir, "data.bin")).equals(binary)).toBe(true);

    const nested = await curl(
      ["--output-dir", "a/b", "--create-dirs", "-o", "x.txt", `${base}/hello.txt`],
      dir,
    );
    expect(nested.code).toBe(0);
    expect(readFileSync(path.join(dir, "a/b/x.txt"), "utf8")).toBe("hello world\n");

    const nameless = await curl(["-O", `${base}/dir/`], dir);
    expect(nameless.code).toBe(23);
    expect(nameless.err).toContain("Remote file name has no length");
  });

  it("keeps binary bodies intact on stdout", async () => {
    const result = await curl(["-s", `${base}/bin/data.bin`]);
    expect(result.stdout.equals(binary)).toBe(true);
  });

  it("includes headers with -i and prints only headers with -I", async () => {
    const included = await curl(["-i", `${base}/hello.txt`]);
    expect(included.out).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(included.out).toContain("x-test: yes\r\n");
    expect(included.out.endsWith("\r\n\r\nhello world\n")).toBe(true);

    const head = await curl(["-I", `${base}/hello.txt`]);
    expect(head.out).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(head.out).toContain("content-type: text/plain\r\n");
    expect(head.out).not.toContain("hello world");
    expect(head.out.endsWith("\r\n\r\n")).toBe(true);
  });

  it("sends -X, -d, --json, -H, -A, -e and -u", async () => {
    const form = echoed(await curl(["-d", "a=1", "-d", "b=2", `${base}/echo`]));
    expect(form).toMatchObject({ method: "POST", body: "a=1&b=2" });
    expect(form.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(form.headers["user-agent"]).toMatch(/^curl\//);

    const put = echoed(
      await curl(["-X", "PUT", "--data-binary", "@-", `${base}/echo`], undefined, "x\ny\n"),
    );
    expect(put).toMatchObject({ method: "PUT", body: "x\ny\n" });
    const stripped = echoed(await curl(["-d", "@-", `${base}/echo`], undefined, "x\ny\n"));
    expect(stripped.body).toBe("xy");
    const encoded = echoed(await curl(["--data-urlencode", "q=a b&c", `${base}/echo`]));
    expect(encoded.body).toBe("q=a%20b%26c");

    const json = echoed(await curl(["--json", '{"x":1}', `${base}/echo`]));
    expect(json).toMatchObject({ method: "POST", body: '{"x":1}' });
    expect(json.headers["content-type"]).toBe("application/json");
    expect(json.headers.accept).toBe("application/json");

    const headers = echoed(
      await curl([
        "-H",
        "X-One: 1",
        "-H",
        "X-Gone: 1",
        "-H",
        "X-Gone:",
        "-H",
        "X-Empty;",
        "-A",
        "agent/1",
        "-e",
        "http://ref/",
        "-u",
        "me:secret",
        `${base}/echo`,
      ]),
    );
    expect(headers.method).toBe("GET");
    expect(headers.headers["x-one"]).toBe("1");
    expect(headers.headers["user-agent"]).toBe("agent/1");
    expect(headers.headers.referer).toBe("http://ref/");
    expect(headers.headers.authorization).toBe(
      `Basic ${Buffer.from("me:secret").toString("base64")}`,
    );
    // "Name:" removes a header, "Name;" sends it empty.
    expect(headers.headers["x-gone"]).toBeUndefined();
    expect(headers.headers["x-empty"]).toBe("");
  });

  it("moves -d data into the query with -G", async () => {
    const result = echoed(await curl(["-G", "-d", "q=1", "-d", "r=2", `${base}/echo?p=0`]));
    expect(result).toMatchObject({ method: "GET", query: "?p=0&q=1&r=2", body: "" });
  });

  it("follows redirects only with -L", async () => {
    const stay = await curl(["-s", "-w", "%{http_code} %{redirect_url}", `${base}/redirect?n=2`]);
    expect(stay.out).toBe(`moved\n302 ${base}/redirect?n=1`);

    const follow = await curl([
      "-L",
      "-w",
      "%{http_code} %{url_effective} %{num_redirects}\\n",
      `${base}/redirect?n=2`,
    ]);
    expect(follow.out).toBe(`hello world\n200 ${base}/hello.txt 2\n`);

    const limited = await curl(["-sS", "-L", "--max-redirs", "1", `${base}/redirect?n=2`]);
    expect(limited.code).toBe(47);
    expect(limited.err).toContain("Maximum (1) redirects followed");

    const post = echoed(await curl(["-sL", "-d", "a=1", `${base}/post-redirect`]));
    expect(post).toMatchObject({ method: "GET", body: "" });
  });

  it("fails with exit 22 under -f, quietly with -s and loudly again with -S", async () => {
    const plain = await curl([`${base}/missing`]);
    expect(plain).toMatchObject({ out: "no such page\n", code: 0 });

    const failed = await curl(["-f", `${base}/missing`]);
    expect(failed).toMatchObject({ out: "", code: 22 });
    expect(failed.err).toBe("curl: (22) The requested URL returned error: 404\n");

    expect(await curl(["-fs", `${base}/missing`])).toMatchObject({ out: "", err: "", code: 22 });
    expect((await curl(["-fsS", `${base}/missing`])).err).toContain("(22)");

    const withBody = await curl(["-s", "--fail-with-body", `${base}/missing`]);
    expect(withBody).toMatchObject({ out: "no such page\n", code: 22 });
  });

  it("handles combined short flags like -fsSL", async () => {
    expect(await curl(["-fsSL", `${base}/redirect`])).toMatchObject({
      out: "hello world\n",
      err: "",
      code: 0,
    });
  });

  it("writes -w variables after the transfer", async () => {
    const result = await curl([
      "-s",
      "-o",
      "/dev/null",
      "--write-out=%{http_code}|%{content_type}|%{size_download}|%{time_total}\\n",
      `${base}/hello.txt`,
    ]);
    expect(result.out).toMatch(/^200\|text\/plain\|12\|\d+\.\d{6}\n$/);
  });

  it("times out with exit 28 under -m", async () => {
    const started = Date.now();
    const result = await curl(["-sS", "-m", "0.3", "-w", "%{http_code}", `${base}/slow`]);
    expect(result.code).toBe(28);
    expect(result.out).toBe("000");
    expect(result.err).toMatch(/^curl: \(28\) Operation timed out/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reports a refused connection with exit 7 and no relay hint for local hosts", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const result = await curl([`http://127.0.0.1:${port}/`]);
    expect(result.code).toBe(7);
    expect(result.err).toContain(`curl: (7) Failed to connect to 127.0.0.1 port ${port}`);
    expect(result.err).not.toContain("relay");
  });

  it("rejects other protocols, unknown options and -F", async () => {
    expect(await curl(["ftp://example.com/x"])).toMatchObject({
      err: 'curl: (1) Protocol "ftp" not supported\n',
      code: 1,
    });
    expect((await curl(["--bogus", base])).code).toBe(2);
    const form = await curl(["-F", "a=1", base]);
    expect(form.code).toBe(2);
    expect(form.err).toContain("not supported");
  });

  it("defaults scheme-less URLs to http", async () => {
    const result = await curl([`${base.replace("http://", "")}/hello.txt`]);
    expect(result).toMatchObject({ out: "hello world\n", code: 0 });
  });
});

describe("wget", () => {
  it("saves to the remote name and adds .1 when it is taken", async () => {
    const dir = tempDir();
    const first = await wget([`${base}/hello.txt`], dir);
    expect(first.code).toBe(0);
    expect(first.err).toContain("Saving to: 'hello.txt'");
    expect(first.err).toContain("'hello.txt' saved [12/12]");
    expect(readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe("hello world\n");

    const second = await wget(["-q", `${base}/hello.txt`], dir);
    expect(second).toMatchObject({ err: "", code: 0 });
    expect(readFileSync(path.join(dir, "hello.txt.1"), "utf8")).toBe("hello world\n");

    await wget(["-q", `${base}/dir/`], dir);
    expect(readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<p>index</p>\n");
  });

  it("writes to stdout with -O - (and -qO-)", async () => {
    expect(await wget(["-qO-", `${base}/hello.txt`])).toMatchObject({
      out: "hello world\n",
      err: "",
      code: 0,
    });
    const binaryResult = await wget(["-q", "-O", "-", `${base}/bin/data.bin`]);
    expect(binaryResult.stdout.equals(binary)).toBe(true);
  });

  it("saves under -P and follows redirects", async () => {
    const dir = tempDir();
    const result = await wget(["-P", "downloads/new", `${base}/redirect?n=2`], dir);
    expect(result.code).toBe(0);
    expect(result.err).toContain("Location: /hello.txt [following]");
    // Named after the URL asked for, as wget does.
    expect(readFileSync(path.join(dir, "downloads/new/redirect"), "utf8")).toBe("hello world\n");
  });

  it("exits 8 on an HTTP error without saving", async () => {
    const dir = tempDir();
    const result = await wget([`${base}/missing`], dir);
    expect(result.code).toBe(8);
    expect(result.err).toContain("ERROR 404: Not Found.");
    expect(existsSync(path.join(dir, "missing"))).toBe(false);
  });

  it("exits 4 when the connection fails", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const result = await wget([`http://127.0.0.1:${port}/`]);
    expect(result.code).toBe(4);
    expect(result.err).toContain("Connection refused.");
  });

  it("sends --header, -U and --post-data", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "keep"), "");
    const result = await wget(
      ["-qO-", "--header=X-Two: 2", "-U", "agent/2", "--post-data", "a=1", `${base}/echo`],
      dir,
    );
    expect(echoed(result)).toMatchObject({
      method: "POST",
      body: "a=1",
      headers: { "x-two": "2", "user-agent": "agent/2" },
    });
  });
});
