/**
 * A local git smart-HTTP server for the browser smoke, so pushes and clones
 * run end to end without GitHub: requests shaped like the host's git relay
 * (`/api/git/github.com/<owner>/<repo>.git/...`) are answered by
 * `git http-backend` over bare repositories created on demand.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export function startGitServer(root: string) {
  mkdirSync(root, { recursive: true });
  const repoDir = (owner: string, repo: string) => join(root, owner, repo);
  const ensure = (owner: string, repo: string) => {
    const dir = repoDir(owner, repo);
    if (existsSync(dir)) return dir;
    mkdirSync(join(root, owner), { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "--initial-branch=main", dir]);
    execFileSync("git", ["--git-dir", dir, "config", "http.receivepack", "true"]);
    return dir;
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/(?:api\/git\/)?github\.com\/([^/]+)\/([^/]+\.git)(\/.*)$/.exec(url.pathname);
    if (!match) {
      response.writeHead(404);
      response.end("not a git path");
      return;
    }
    const [, owner = "", repo = "", rest = ""] = match;
    ensure(owner, repo);
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/${owner}/${repo}${rest}`,
        REQUEST_METHOD: request.method ?? "GET",
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
        CONTENT_LENGTH: String(request.headers["content-length"] ?? ""),
        REMOTE_USER: "ada",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    request.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString("utf8").split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") status = Number(value.split(" ")[0]) || 200;
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      response.write(head.subarray(end + 4));
    });
    child.stdout.on("end", () => response.end());
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`git-http-backend: ${chunk}`));
  });
  return new Promise<{
    port: number;
    close: () => void;
    repoDir: (owner: string, repo: string) => string;
    git: (owner: string, repo: string, args: string[]) => string;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => server.close(),
        repoDir,
        git: (owner, repo, args) =>
          execFileSync("git", ["--git-dir", repoDir(owner, repo), ...args], { encoding: "utf8" }),
      }),
    );
  });
}
