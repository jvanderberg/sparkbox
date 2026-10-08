/**
 * A project's git repository, run by isomorphic-git in the page. Objects
 * live in a GitStore the owner persists; the working tree is the sandbox.
 * Network operations go through the host's git proxy with the user's token
 * added here, so the token never enters the sandbox.
 */
import "./buffer-shim.ts";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { computeChanges, type FileMap } from "../workspace/changes.ts";
import type { Changes } from "../workspace/types.ts";
import { createGitFs, type GitStore, gitDir, type Worktree, workDir } from "./fs.ts";

export type Author = { name: string; email: string };

export type GitOptions = {
  author: () => Author;
  /** The host route that relays smart-HTTP to GitHub; empty without a host. */
  proxyUrl: () => string;
  /** The GitHub token for pushes and private reads, if signed in. */
  token: () => string;
};

export type LogEntry = { sha: string; message: string; author: string; date: Date };

export const defaultBranch = "main";

export const defaultIgnore = `# Written by Sparkbox. Dependencies and build output are reinstalled, not kept.
node_modules/
dist/
build/
coverage/
.cache/
.pnpm-store/
.sparkbox/
`;

const decoder = new TextDecoder();

export class GitError extends Error {}

/** isomorphic-git's errors carry a code; turn the common ones into plain words. */
export function describeGitError(error: unknown): string {
  if (error instanceof git.Errors.PushRejectedError)
    return "The remote has commits this project does not. Pull first, then push again.";
  if (error instanceof git.Errors.MergeConflictError)
    return `Merge conflict in ${error.data.filepaths.join(", ")}. Resolve the files, then commit.`;
  if (error instanceof git.Errors.MergeNotSupportedError)
    return "This merge is more than Sparkbox's git can do. Commit, then pull with --no-rebase on a machine with git.";
  if (error instanceof git.Errors.HttpError) {
    if (error.data.statusCode === 401 || error.data.statusCode === 403)
      return "GitHub refused the push. Sign in to GitHub again from Settings.";
    if (error.data.statusCode === 404) return "GitHub has no such repository, or no access to it.";
    return `GitHub answered ${error.data.statusCode} ${error.data.statusMessage}.`;
  }
  if (error instanceof git.Errors.NotFoundError) return `Not found: ${error.data.what}.`;
  if (error instanceof git.Errors.CheckoutConflictError)
    return `Local changes would be overwritten: ${error.data.filepaths.join(", ")}. Commit or discard them first.`;
  if (error instanceof git.Errors.AlreadyExistsError)
    return `${error.data.noun} ${error.data.where} already exists.`;
  if (error instanceof git.Errors.FastForwardError)
    return "The branches have diverged; a merge is needed.";
  if (error instanceof Error) return error.message;
  return String(error);
}

export class Repository {
  readonly fs: ReturnType<typeof createGitFs>;
  private base: { fs: ReturnType<typeof createGitFs>; dir: string; gitdir: string };
  private cache = {};

  constructor(
    readonly worktree: Worktree,
    readonly store: GitStore,
    private options: GitOptions,
  ) {
    this.fs = createGitFs(worktree, store);
    this.base = { fs: this.fs, dir: workDir, gitdir: gitDir };
  }

  private get ctx() {
    return { ...this.base, cache: this.cache };
  }

  private network() {
    const proxy = this.options.proxyUrl();
    if (!proxy)
      throw new GitError(
        "Pushing and pulling need the Sparkbox host, which this deployment does not have.",
      );
    const token = this.options.token();
    return {
      http,
      corsProxy: proxy,
      onAuth: () => (token ? { username: "x-access-token", password: token } : undefined),
      onAuthFailure: () => ({ cancel: true }),
    };
  }

  /** True once the store holds a repository. */
  initialized() {
    return Boolean(this.store.get("HEAD"));
  }

  /** Create the repository and a .gitignore if there is none yet. */
  async ensure(): Promise<boolean> {
    if (this.initialized()) return false;
    await git.init({ ...this.base, defaultBranch });
    if (!(await this.worktree.stat(".gitignore")))
      await this.worktree.writeFile(".gitignore", defaultIgnore);
    return true;
  }

  async currentBranch(): Promise<string> {
    return (await git.currentBranch({ ...this.ctx, fullname: false })) ?? "(detached)";
  }

  async head(): Promise<string | null> {
    try {
      return await git.resolveRef({ ...this.ctx, ref: "HEAD" });
    } catch {
      return null;
    }
  }

  /** Every file's state against HEAD and the index. */
  async matrix(filter?: (path: string) => boolean) {
    return git.statusMatrix({ ...this.ctx, filter });
  }

  /** The blob at `path` in `ref`, or null when the tree has no such file. */
  async blobAt(ref: string, path: string): Promise<Uint8Array | null> {
    try {
      const oid = await git.resolveRef({ ...this.ctx, ref });
      const { blob } = await git.readBlob({ ...this.ctx, oid, filepath: path });
      return blob;
    } catch {
      return null;
    }
  }

  /**
   * Changes in the working tree against HEAD, with unified diffs: what the
   * Changes view shows and what Back up commits.
   */
  async changes(): Promise<Changes> {
    const rows = await this.matrix();
    const before: FileMap = {};
    const after: FileMap = {};
    for (const [path, head, workdir] of rows) {
      if (head === 1 && workdir === 1) continue;
      if (head === 1) before[path] = (await this.blobAt("HEAD", path)) ?? new Uint8Array();
      if (workdir !== 0) after[path] = await this.worktree.readFile(path);
    }
    return computeChanges(before, after, "HEAD");
  }

  /** Stage every change (additions, edits and deletions) under `paths`, or everything. */
  async addAll(paths?: string[]): Promise<number> {
    const within = (path: string) =>
      !paths || paths.some((p) => p === "." || path === p || path.startsWith(`${p}/`));
    const rows = await this.matrix(within);
    let count = 0;
    for (const [path, head, workdir, stage] of rows) {
      if (head === 1 && workdir === 1 && stage === 1) continue;
      if (workdir === 0) {
        if (stage !== 0) await git.remove({ ...this.ctx, filepath: path });
      } else if (workdir !== stage || workdir === 2) await git.add({ ...this.ctx, filepath: path });
      count++;
    }
    return count;
  }

  /** True when the index differs from HEAD. */
  async staged(): Promise<boolean> {
    return (await this.matrix()).some(([, head, , stage]) => head !== stage);
  }

  async commit(message: string): Promise<string> {
    return git.commit({ ...this.ctx, message, author: this.options.author() });
  }

  /** Stage everything and commit; null when there was nothing to commit. */
  async commitAll(message: string): Promise<string | null> {
    await this.addAll();
    if (!(await this.staged())) return null;
    return this.commit(message);
  }

  async log(depth = 20, ref = "HEAD"): Promise<LogEntry[]> {
    try {
      const entries = await git.log({ ...this.ctx, depth, ref });
      return entries.map((entry) => ({
        sha: entry.oid,
        message: entry.commit.message.replace(/\n+$/, ""),
        author: entry.commit.author.name,
        date: new Date(entry.commit.author.timestamp * 1000),
      }));
    } catch (error) {
      if (error instanceof git.Errors.NotFoundError) return [];
      throw error;
    }
  }

  async branches(): Promise<string[]> {
    return git.listBranches(this.ctx);
  }

  async createBranch(name: string, checkout = false) {
    await git.branch({ ...this.ctx, ref: name, checkout });
  }

  async deleteBranch(name: string) {
    await git.deleteBranch({ ...this.ctx, ref: name });
  }

  /** Switch branches, or restore `paths` from `ref` when given. */
  async checkout(ref: string, options: { force?: boolean; paths?: string[] } = {}) {
    await git.checkout({
      ...this.ctx,
      ref,
      force: options.force,
      filepaths: options.paths,
      noUpdateHead: Boolean(options.paths),
    });
  }

  async merge(
    theirs: string,
  ): Promise<{ sha: string; fastForward: boolean; alreadyMerged: boolean }> {
    const ours = await this.currentBranch();
    const result = await git.merge({
      ...this.ctx,
      ours,
      theirs,
      author: this.options.author(),
      abortOnConflict: true,
    });
    // The merge updates refs and index; bring the working tree along.
    await git.checkout({ ...this.ctx, ref: ours, force: true });
    return {
      sha: result.oid ?? "",
      fastForward: Boolean(result.fastForward),
      alreadyMerged: Boolean(result.alreadyMerged),
    };
  }

  async unstage(paths?: string[]) {
    const rows = await this.matrix(
      (path) => !paths || paths.some((p) => p === "." || path === p || path.startsWith(`${p}/`)),
    );
    for (const [path, head, , stage] of rows)
      if (head !== stage) await git.resetIndex({ ...this.ctx, filepath: path });
  }

  async remote(): Promise<string | null> {
    const remotes = await git.listRemotes(this.ctx);
    return remotes.find((entry) => entry.remote === "origin")?.url ?? null;
  }

  async setRemote(url: string) {
    await git.addRemote({ ...this.ctx, remote: "origin", url, force: true });
  }

  async fetch() {
    const branch = await this.currentBranch();
    await git.fetch({
      ...this.ctx,
      ...this.network(),
      remote: "origin",
      ref: branch,
      singleBranch: true,
    });
  }

  async push(options: { force?: boolean } = {}) {
    const branch = await this.currentBranch();
    const result = await git.push({
      ...this.ctx,
      ...this.network(),
      remote: "origin",
      ref: branch,
      remoteRef: branch,
      force: options.force,
    });
    if (!result.ok || result.error) throw new GitError(result.error ?? "The push was refused.");
  }

  async pull() {
    const branch = await this.currentBranch();
    await git.pull({
      ...this.ctx,
      ...this.network(),
      remote: "origin",
      ref: branch,
      singleBranch: true,
      author: this.options.author(),
    });
  }

  /** Clone `url` into an empty working tree and store. */
  async clone(url: string) {
    await git.clone({ ...this.base, ...this.network(), url, singleBranch: true });
  }

  /** The commit message, author and date of a commit. */
  async show(ref: string): Promise<LogEntry | null> {
    const entries = await this.log(1, ref);
    return entries[0] ?? null;
  }

  /** Changes between two states: "HEAD" or another ref, "STAGE", or "WORKDIR". */
  async diff(from: string, to: string, paths?: string[]): Promise<Changes> {
    const within = (path: string) =>
      !paths || paths.some((p) => p === "." || path === p || path.startsWith(`${p}/`));
    const treeOf = (name: string) =>
      name === "WORKDIR" ? git.WORKDIR() : name === "STAGE" ? git.STAGE() : git.TREE({ ref: name });
    const before: FileMap = {};
    const after: FileMap = {};
    await git.walk({
      ...this.ctx,
      trees: [treeOf(from), treeOf(to)],
      map: async (path, [a, b]) => {
        if (path === ".") return;
        if (!within(path)) return;
        const typeA = await a?.type();
        const typeB = await b?.type();
        if (typeA === "tree" || typeB === "tree") return;
        const oidA = await a?.oid();
        const oidB = await b?.oid();
        if (oidA === oidB) return;
        if (a && typeA === "blob") before[path] = (await a.content()) ?? new Uint8Array();
        if (b && typeB === "blob") after[path] = (await b.content()) ?? new Uint8Array();
        return;
      },
    });
    return computeChanges(before, after, from);
  }

  async tags(): Promise<string[]> {
    return git.listTags(this.ctx);
  }
  async tag(name: string) {
    await git.tag({ ...this.ctx, ref: name });
  }

  /** The text of a file at HEAD, for callers that want to show it. */
  async textAt(ref: string, path: string): Promise<string | null> {
    const blob = await this.blobAt(ref, path);
    return blob ? decoder.decode(blob) : null;
  }
}
