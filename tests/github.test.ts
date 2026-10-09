import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError } from "../src/github/api.ts";
import {
  commitMessage,
  filesHoldingSecrets,
  pagesWorkflow,
  projectKind,
  repositoryName,
  siteCheckScript,
  workflowPath,
} from "../src/github/git.ts";
import { publishFiles, siteState } from "../src/github/sync.ts";

const text = (value: string) => new TextEncoder().encode(value);
const repo = { owner: "ada", name: "demo", branch: "main", htmlUrl: "https://github.com/ada/demo" };

describe("filesHoldingSecrets", () => {
  it("names files that contain a secret's value and ignores short values and binaries", () => {
    const files = {
      "src/app.ts": text('const key = "sk-live-1234567890";'),
      "README.md": text("no secrets here"),
      "img.png": new Uint8Array([0, 1, 2, ...text("sk-live-1234567890")]),
    };
    expect(filesHoldingSecrets(files, { API_KEY: "sk-live-1234567890", SHORT: "abc" })).toEqual([
      "src/app.ts",
    ]);
    expect(filesHoldingSecrets(files, {})).toEqual([]);
  });
});

describe("projectKind and publishFiles", () => {
  it("treats a project with vite as a workflow build and anything else as static", () => {
    expect(projectKind({ "index.html": text("<html>") })).toBe("static");
    expect(projectKind({ "package.json": text('{"devDependencies":{"vite":"^7"}}') })).toBe("vite");
    expect(projectKind({ "package.json": text("not json") })).toBe("static");
  });
  it("adds the workflow for vite projects and a Jekyll opt-out for static ones", () => {
    const vite = publishFiles({
      "package.json": text('{"devDependencies":{"vite":"^7"}}'),
      "pnpm-lock.yaml": text(""),
    });
    expect(vite.kind).toBe("vite");
    const workflow = new TextDecoder().decode(vite.added[workflowPath]);
    expect(workflow).toContain("npm install -g pnpm@10");
    expect(workflow).toContain("pnpm install --ignore-scripts");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a template
    expect(workflow).toContain("--base=/${{ github.event.repository.name }}/");
    expect(workflow).toContain("actions/deploy-pages@v4");
    expect(workflow).toContain("Check that the files the app fetches were published");
    const stat = publishFiles({ "index.html": text("<html>") });
    expect(stat.kind).toBe("static");
    expect(Object.keys(stat.added)).toEqual([".nojekyll"]);
    expect(
      Object.keys(publishFiles({ "index.html": text(""), ".nojekyll": text("") }).added),
    ).toEqual([]);
    expect(pagesWorkflow({ pnpm: false })).toContain("npm install --ignore-scripts");
  });
  it("fails the build when the app fetches a project file the site lacks or a root path", () => {
    const check = (files: Record<string, string>) => {
      const root = mkdtempSync(join(tmpdir(), "sparkbox-site-"));
      try {
        for (const [path, content] of Object.entries(files)) {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), content);
        }
        const run = spawnSync(process.execPath, ["-"], {
          cwd: root,
          input: siteCheckScript,
          env: { ...process.env, SITE_BASE: "/demo/" },
          encoding: "utf8",
        });
        return { status: run.status, errors: run.stderr };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    const app =
      'fetch("/demo/data/stops.json");fetch("https://example.com/x.json");fetch("package.json")';
    const missing = check({
      "data/stops.json": "[]",
      "package.json": "{}",
      "dist/index.html": "<html>",
      "dist/assets/index.js": app,
    });
    expect(missing.status).toBe(1);
    expect(missing.errors).toContain("Move it to public/data/stops.json");
    expect(missing.errors.trim().split("\n")).toHaveLength(1);
    expect(check({ "dist/data/stops.json": "[]", "dist/assets/index.js": app }).status).toBe(0);
    const rooted = check({
      "dist/data/stops.json": "[]",
      "dist/assets/index.js": 'fetch("/data/stops.json")',
    });
    expect(rooted.status).toBe(1);
    expect(rooted.errors).toContain("points at the domain root");
  });
  it("refreshes a workflow Sparkbox wrote and leaves an edited one alone", () => {
    const manifest = text('{"devDependencies":{"vite":"^7"}}');
    const stale = text("# Written by Sparkbox. Builds the app\nname: old\n");
    expect(
      Object.keys(publishFiles({ "package.json": manifest, [workflowPath]: stale }).added),
    ).toEqual([workflowPath]);
    const edited = text("name: mine\n");
    expect(
      Object.keys(publishFiles({ "package.json": manifest, [workflowPath]: edited }).added),
    ).toEqual([]);
    const current = text(pagesWorkflow({ pnpm: false }));
    expect(
      Object.keys(publishFiles({ "package.json": manifest, [workflowPath]: current }).added),
    ).toEqual([]);
  });
});

describe("names", () => {
  it("derives repository names and commit messages", () => {
    expect(repositoryName("Oak Park Transit!")).toBe("oak-park-transit");
    expect(repositoryName("***")).toBe("sparkbox-project");
    expect(commitMessage("  Add a map\nwith stops ")).toBe("Add a map");
    expect(commitMessage("")).toBe("Update from Sparkbox");
    expect(commitMessage("x".repeat(100))).toHaveLength(72);
  });
});

describe("GitHubClient", () => {
  it("retries a taken repository name with a suffix", async () => {
    let attempts = 0;
    const client = new GitHubClient("tok", async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.auto_init).toBe(false);
      attempts++;
      if (attempts === 1)
        return new Response(
          JSON.stringify({
            message: "Validation Failed",
            errors: [{ message: "name already exists on this account" }],
          }),
          { status: 422 },
        );
      return new Response(
        JSON.stringify({
          owner: { login: "ada" },
          name: body.name,
          default_branch: "main",
          html_url: "u",
        }),
        { status: 201 },
      );
    });
    const created = await client.createRepository("demo", "d");
    expect(created.name).toBe("demo-2");
  });
  it("explains a rejected sign-in", async () => {
    const client = new GitHubClient(
      "tok",
      async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
    );
    await expect(client.user()).rejects.toThrow(GitHubError);
    await expect(client.user()).rejects.toThrow(/Sign in again/);
  });
});

describe("siteState", () => {
  const fetchFn = async (input: string) => {
    const path = new URL(input).pathname;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path === "/repos/ada/demo/actions/runs")
      return json({
        workflow_runs: [{ status: "completed", conclusion: "success", html_url: "run" }],
      });
    if (path === "/repos/ada/demo/pages/builds/latest")
      return json({ status: "built", commit: "c1", error: { message: null } });
    return new Response("{}", { status: 404 });
  };
  it("reads the workflow run for vite projects and the Pages build otherwise", async () => {
    const client = new GitHubClient("tok", fetchFn);
    expect(await siteState(client, repo, "vite", "c1")).toEqual({ state: "live" });
    expect(await siteState(client, repo, "static", "c1")).toEqual({ state: "live" });
    expect((await siteState(client, repo, "static", "other")).state).toBe("building");
  });
});
