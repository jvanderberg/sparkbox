import * as git from "isomorphic-git";
import { beforeEach, describe, expect, it } from "vitest";
import { runGitCommand } from "../src/git/cli.ts";
import { GitStore } from "../src/git/fs.ts";
import { Repository } from "../src/git/repo.ts";
import { MemorySandbox } from "../src/sandbox/memory.ts";

const decode = (value: Uint8Array) => new TextDecoder().decode(value);

function setup(files: Record<string, string> = {}) {
  const sandbox = new MemorySandbox(files);
  const store = new GitStore();
  const repo = new Repository(sandbox, store, {
    author: () => ({ name: "Ada", email: "ada@example.org" }),
    proxyUrl: () => "",
    token: () => "",
  });
  return { sandbox, store, repo };
}

describe("Repository", () => {
  let sandbox: MemorySandbox;
  let store: GitStore;
  let repo: Repository;
  beforeEach(() => {
    ({ sandbox, store, repo } = setup({ "PROJECT.md": "# Demo\n", "src/app.js": "one\n" }));
  });

  it("initializes with a .gitignore and commits everything", async () => {
    expect(repo.initialized()).toBe(false);
    expect(await repo.ensure()).toBe(true);
    expect(repo.initialized()).toBe(true);
    expect(await sandbox.readText(".gitignore")).toContain("node_modules/");
    expect(store.dirty).toBe(true);
    const sha = await repo.commitAll("Start");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.commitAll("Nothing")).toBeNull();
    const log = await repo.log();
    expect(log.map((entry) => entry.message)).toEqual(["Start"]);
    expect(await repo.currentBranch()).toBe("main");
  });

  it("reports changes against HEAD with diffs, and never looks inside ignored directories", async () => {
    await repo.ensure();
    await repo.commitAll("Start");
    await sandbox.writeFile("src/app.js", "one\ntwo\n");
    await sandbox.writeFile("new.txt", "fresh\n");
    await sandbox.writeFile("node_modules/pkg/index.js", "ignored");
    await sandbox.deleteFile("PROJECT.md");
    const changes = await repo.changes();
    expect(changes.base).toBe("HEAD");
    expect(changes.files.map((file) => [file.path, file.status])).toEqual([
      ["PROJECT.md", "deleted"],
      ["new.txt", "added"],
      ["src/app.js", "modified"],
    ]);
    expect(changes.files[2]?.diff).toContain("+two");
    await repo.commitAll("Edit");
    expect((await repo.changes()).files).toEqual([]);
    const blob = await repo.blobAt("HEAD", "src/app.js");
    expect(blob && decode(blob)).toBe("one\ntwo\n");
    expect(await repo.blobAt("HEAD", "node_modules/pkg/index.js")).toBeNull();
  });

  it("notices a same-size edit", async () => {
    await repo.ensure();
    await repo.commitAll("Start");
    await sandbox.writeFile("src/app.js", "two\n");
    expect((await repo.changes()).files.map((file) => file.path)).toEqual(["src/app.js"]);
  });

  it("survives a reload of the store", async () => {
    await repo.ensure();
    await repo.commitAll("Start");
    const reopened = new Repository(sandbox, new GitStore(store.toRecord()), {
      author: () => ({ name: "Ada", email: "ada@example.org" }),
      proxyUrl: () => "",
      token: () => "",
    });
    expect(reopened.initialized()).toBe(true);
    expect((await reopened.log()).map((entry) => entry.message)).toEqual(["Start"]);
  });

  it("branches, merges and restores", async () => {
    await repo.ensure();
    await repo.commitAll("Start");
    await repo.createBranch("feature", true);
    await sandbox.writeFile("feature.txt", "yes\n");
    await repo.commitAll("Add feature");
    await repo.checkout("main");
    expect(await sandbox.exists("feature.txt")).toBe(false);
    const merged = await repo.merge("feature");
    expect(merged.fastForward).toBe(true);
    expect(await sandbox.readText("feature.txt")).toBe("yes\n");
    await sandbox.writeFile("feature.txt", "changed\n");
    await repo.checkout("HEAD", { force: true, paths: ["feature.txt"] });
    expect(await sandbox.readText("feature.txt")).toBe("yes\n");
  });

  it("refuses network operations without a host", async () => {
    await repo.ensure();
    await repo.commitAll("Start");
    await repo.setRemote("https://github.com/ada/demo.git");
    expect(await repo.remote()).toBe("https://github.com/ada/demo.git");
    await expect(repo.push()).rejects.toThrow(/Sparkbox host/);
  });

  it("recognizes GitHub's README-only starter commit on the remote", async () => {
    await repo.ensure();
    await repo.commitAll("Start");
    expect(await repo.remoteIsGitHubStarter()).toBe(false);
    const ctx = { fs: repo.fs, dir: "/work", gitdir: "/git" };
    const remote = async (message: string, files: string[]) => {
      const tree = await git.writeTree({
        ...ctx,
        tree: await Promise.all(
          files.map(async (path) => ({
            mode: "100644",
            path,
            type: "blob" as const,
            oid: await git.writeBlob({ ...ctx, blob: new TextEncoder().encode("# demo\n") }),
          })),
        ),
      });
      const who = { name: "GitHub", email: "noreply@github.com", timestamp: 0, timezoneOffset: 0 };
      const oid = await git.writeCommit({
        ...ctx,
        commit: { message: `${message}\n`, tree, parent: [], author: who, committer: who },
      });
      await git.writeRef({ ...ctx, ref: "refs/remotes/origin/main", value: oid, force: true });
    };
    await remote("Initial commit", ["README.md"]);
    expect(await repo.remoteIsGitHubStarter()).toBe(true);
    await remote("Initial commit", ["README.md", "index.html"]);
    expect(await repo.remoteIsGitHubStarter()).toBe(false);
    await remote("Someone's own start", ["README.md"]);
    expect(await repo.remoteIsGitHubStarter()).toBe(false);
  });
});

describe("git command", () => {
  it("behaves like git for the everyday commands", async () => {
    const { sandbox, repo } = setup({ "PROJECT.md": "# Demo\n" });
    const run = (line: string) => runGitCommand(repo, line.split(" ").filter(Boolean));
    expect((await run("status")).stdout).toContain("Untracked files:");
    expect((await run("commit -m x")).code).toBe(1);
    expect((await run("add -A")).code).toBe(0);
    const commit = await run("commit -m Start");
    expect(commit.stdout).toMatch(/^\[main [0-9a-f]{7}\] Start/);
    expect((await run("status")).stdout).toContain("nothing to commit, working tree clean");
    await sandbox.writeFile("PROJECT.md", "# Demo\nMore\n");
    expect((await run("status --short")).stdout).toBe(" M PROJECT.md\n");
    const diff = await run("diff");
    expect(diff.stdout).toContain("diff --git a/PROJECT.md b/PROJECT.md");
    expect(diff.stdout).toContain("+More");
    expect((await run("commit -am Edit")).code).toBe(0);
    const log = await run("log --oneline");
    expect(log.stdout.split("\n").filter(Boolean)).toHaveLength(2);
    expect(log.stdout).toContain("Edit");
    expect((await run("show HEAD")).stdout).toContain("+More");
    expect((await run("checkout -b topic")).stdout).toContain("Switched to a new branch 'topic'");
    expect((await run("branch")).stdout).toBe("  main\n* topic\n");
    expect((await run("rev-parse --abbrev-ref HEAD")).stdout).toBe("topic\n");
    expect((await run("push")).stderr).toContain("Back up to GitHub");
    await repo.setRemote("https://github.com/ada/demo.git");
    expect((await run("push --force")).stderr).toContain("force pushes are not available");
    await sandbox.writeFile("PROJECT.md", "scratch\n");
    expect((await run("reset --hard")).stdout).toMatch(/^HEAD is now at [0-9a-f]{7}/);
    expect(await sandbox.readText("PROJECT.md")).toBe("# Demo\nMore\n");
    expect((await run("rev-parse --abbrev-ref HEAD")).stdout).toBe("topic\n");
    expect((await run("reset --hard main")).stderr).toContain("not available here");
    expect((await run("stash")).code).toBe(128);
    expect((await run("frobnicate")).stderr).toContain("not a git command Sparkbox supports");
    expect((await run("--version")).stdout).toContain("isomorphic-git");
  });

  it("stages, unstages and removes files", async () => {
    const { sandbox, repo } = setup({ "a.txt": "a\n", "b.txt": "b\n" });
    const run = (line: string) => runGitCommand(repo, line.split(" ").filter(Boolean));
    await run("add -A");
    await run("commit -m Start");
    await sandbox.writeFile("a.txt", "A\n");
    await run("add a.txt");
    expect((await run("diff --staged --name-only")).stdout).toBe("a.txt\n");
    await run("reset a.txt");
    expect((await run("diff --staged --name-only")).stdout).toBe("");
    expect((await run("rm b.txt")).code).toBe(0);
    expect(await sandbox.exists("b.txt")).toBe(false);
    expect((await run("status --short")).stdout).toBe(" M a.txt\nD  b.txt\n");
    await run("restore a.txt");
    expect(await sandbox.readText("a.txt")).toBe("a\n");
  });

  it("diffs named commits, remote branches and ranges, and shows one commit's change", async () => {
    const { sandbox, repo } = setup({ "a.txt": "a\n", "b.txt": "b\n" });
    const run = (line: string) => runGitCommand(repo, line.split(" ").filter(Boolean));
    await run("add -A");
    await run("commit -m Start");
    await run("branch topic");
    await sandbox.writeFile("a.txt", "A\n");
    await run("commit -am Edit");
    await git.writeRef({
      fs: repo.fs,
      gitdir: "/git",
      ref: "refs/remotes/origin/main",
      value: (await repo.resolve("topic")) ?? "",
    });
    const start = (await repo.resolve("topic"))?.slice(0, 7) ?? "";
    for (const line of [
      "diff topic main --name-only",
      "diff origin/main HEAD --name-only",
      "diff origin/main..HEAD --name-only",
      `diff ${start} HEAD --name-only`,
    ])
      expect((await run(line)).stdout, line).toBe("a.txt\n");
    expect((await run("diff origin/main HEAD --name-only -- b.txt")).stdout).toBe("");
    await sandbox.writeFile("b.txt", "B\n");
    expect((await run("diff --name-only b.txt")).stdout).toBe("b.txt\n");
    const show = (await run("show HEAD")).stdout;
    expect(show).toContain("+A");
    expect(show).not.toContain("b.txt");
    expect((await run("show nope")).stderr).toContain("bad revision");
  });
});
