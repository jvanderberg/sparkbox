import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError } from "../src/github/api.ts";
import {
  blobSha,
  commitMessage,
  filesHoldingSecrets,
  pagesWorkflow,
  planPush,
  projectKind,
  repositoryName,
  workflowPath,
} from "../src/github/git.ts";
import { importRepository, publishFiles, pushSnapshot, siteState } from "../src/github/sync.ts";

const text = (value: string) => new TextEncoder().encode(value);
const repo = { owner: "ada", name: "demo", branch: "main", htmlUrl: "https://github.com/ada/demo" };

describe("blobSha", () => {
  it("matches git's blob ids", async () => {
    expect(await blobSha(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await blobSha(text("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("planPush", () => {
  it("uploads only blobs the previous push did not have", async () => {
    const plan = await planPush(
      { "a.txt": text("same"), "b.txt": text("old") },
      { "a.txt": text("same"), "b.txt": text("new"), "c.txt": text("same") },
    );
    expect(plan.entries.map((entry) => entry.path)).toEqual(["a.txt", "b.txt", "c.txt"]);
    // c.txt has a.txt's content, so its blob already exists too.
    expect(plan.upload).toEqual(["b.txt"]);
  });
});

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
    expect(workflow).toContain("pnpm install");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a template
    expect(workflow).toContain("--base=/${{ github.event.repository.name }}/");
    expect(workflow).toContain("actions/deploy-pages@v4");
    const stat = publishFiles({ "index.html": text("<html>") });
    expect(stat.kind).toBe("static");
    expect(Object.keys(stat.added)).toEqual([".nojekyll"]);
    expect(
      Object.keys(publishFiles({ "index.html": text(""), ".nojekyll": text("") }).added),
    ).toEqual([]);
    expect(pagesWorkflow({ pnpm: false })).toContain("npm install");
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

/** Enough of GitHub's Git Data API to push against, in memory. */
function fakeGitHub(options: { headSha?: string | null; failTreeOnce?: boolean } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const blobs = new Map<string, string>();
  let head = options.headSha === undefined ? "parent1" : options.headSha;
  let treeFailures = options.failTreeOnce ? 1 : 0;
  const fetchFn = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
    const path = url.pathname;
    if (path === "/user") return json(200, { login: "ada" });
    if (path === "/user/repos")
      return json(201, {
        owner: { login: "ada" },
        name: body.name,
        default_branch: "main",
        html_url: `https://github.com/ada/${body.name}`,
      });
    if (path === "/repos/ada/demo/git/ref/heads/main")
      return head ? json(200, { object: { sha: head } }) : json(409, { message: "empty" });
    if (path.startsWith("/repos/ada/demo/git/commits/")) return json(200, { tree: "tree0" });
    if (path === "/repos/ada/demo/git/blobs" && method === "POST") {
      const content = Buffer.from(body.content, "base64");
      const sha = await blobSha(new Uint8Array(content));
      blobs.set(sha, content.toString("utf8"));
      return json(201, { sha });
    }
    if (path === "/repos/ada/demo/git/trees" && method === "POST") {
      if (treeFailures-- > 0) return json(422, { message: "Tree SHA does not exist" });
      return json(201, { sha: "tree1" });
    }
    if (path === "/repos/ada/demo/git/commits" && method === "POST")
      return json(201, { sha: "c1" });
    if (path === "/repos/ada/demo/git/refs/heads/main" && method === "PATCH") {
      head = body.sha;
      return json(200, {});
    }
    if (path === "/repos/ada/demo/git/refs" && method === "POST") {
      head = body.sha;
      return json(201, {});
    }
    if (path === "/repos/ada/demo/actions/runs")
      return json(200, {
        workflow_runs: [{ status: "completed", conclusion: "success", html_url: "run" }],
      });
    if (path === "/repos/ada/demo/pages/builds/latest")
      return json(200, { status: "built", commit: "c1", error: { message: null } });
    if (path === "/repos/ada/demo/git/trees/main")
      return json(200, {
        truncated: false,
        tree: [
          { path: "index.html", type: "blob", sha: "b1", size: 6 },
          { path: "node_modules/x.js", type: "blob", sha: "b2", size: 1 },
          { path: "src", type: "tree", sha: "t1" },
        ],
      });
    if (path === "/repos/ada/demo/git/blobs/b1") return new Response("<html>", { status: 200 });
    return json(404, { message: "Not Found" });
  };
  return { fetchFn, calls, blobs, head: () => head };
}

describe("pushSnapshot", () => {
  it("uploads changed blobs, one tree and one commit, then moves the branch", async () => {
    const github = fakeGitHub();
    const client = new GitHubClient("tok", github.fetchFn);
    const previous = { "a.txt": text("same"), "gone.txt": text("bye") };
    const current = { "a.txt": text("same"), "b.txt": text("new") };
    const result = await pushSnapshot(client, repo, previous, current, "Add b");
    expect(result).toEqual({ sha: "c1", uploaded: 1, files: 2, unchanged: false });
    expect([...github.blobs.values()]).toEqual(["new"]);
    const tree = github.calls.find((call) => call.path === "/repos/ada/demo/git/trees");
    if (!tree) throw new Error("no tree was created");
    expect((tree.body as { tree: { path: string }[] }).tree.map((e) => e.path)).toEqual([
      "a.txt",
      "b.txt",
    ]);
    const commit = github.calls.find((call) => call.path === "/repos/ada/demo/git/commits");
    expect(commit?.body).toEqual({ message: "Add b", tree: "tree1", parents: ["parent1"] });
    expect(github.head()).toBe("c1");
  });
  it("creates the branch when the repository is empty", async () => {
    const github = fakeGitHub({ headSha: null });
    const client = new GitHubClient("tok", github.fetchFn);
    await pushSnapshot(client, repo, {}, { "a.txt": text("x") }, "First");
    expect(github.calls.some((call) => call.path === "/repos/ada/demo/git/refs")).toBe(true);
    const commit = github.calls.find((call) => call.path === "/repos/ada/demo/git/commits");
    if (!commit) throw new Error("no commit was created");
    expect((commit.body as { parents: string[] }).parents).toEqual([]);
  });
  it("reports an unchanged snapshot without committing", async () => {
    const github = fakeGitHub();
    const client = new GitHubClient("tok", github.fetchFn);
    const files = { "a.txt": text("same") };
    const result = await pushSnapshot(client, repo, files, { ...files }, "Nothing");
    expect(result.unchanged).toBe(true);
    expect(github.calls.some((call) => call.path === "/repos/ada/demo/git/commits")).toBe(false);
  });
  it("sends every blob when GitHub does not know one it was promised", async () => {
    const github = fakeGitHub({ failTreeOnce: true });
    const client = new GitHubClient("tok", github.fetchFn);
    await pushSnapshot(
      client,
      repo,
      { "a.txt": text("same") },
      { "a.txt": text("same"), "b.txt": text("b") },
      "m",
    );
    expect([...github.blobs.values()].sort()).toEqual(["b", "same"]);
  });
  it("refuses to push a file holding a project secret", async () => {
    const github = fakeGitHub();
    const client = new GitHubClient("tok", github.fetchFn);
    await expect(
      pushSnapshot(client, repo, {}, { "config.js": text("token=supersecretvalue") }, "m", {
        TOKEN: "supersecretvalue",
      }),
    ).rejects.toThrow(/config\.js/);
    expect(github.calls).toEqual([]);
  });
});

describe("GitHubClient", () => {
  it("retries a taken repository name with a suffix", async () => {
    let attempts = 0;
    const client = new GitHubClient("tok", async (_input, init) => {
      const body = JSON.parse(String(init?.body));
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

describe("siteState and importRepository", () => {
  it("reads the workflow run for vite projects and the Pages build otherwise", async () => {
    const client = new GitHubClient("tok", fakeGitHub().fetchFn);
    expect(await siteState(client, repo, "vite", "c1")).toEqual({ state: "live" });
    expect(await siteState(client, repo, "static", "c1")).toEqual({ state: "live" });
    expect((await siteState(client, repo, "static", "other")).state).toBe("building");
  });
  it("fetches the project files and skips ignored directories", async () => {
    const client = new GitHubClient("tok", fakeGitHub().fetchFn);
    const files = await importRepository(client, repo);
    expect(Object.keys(files)).toEqual(["index.html"]);
    expect(new TextDecoder().decode(files["index.html"])).toBe("<html>");
  });
});
