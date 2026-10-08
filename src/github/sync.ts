/**
 * Backing up and publishing a project: one commit per push, Pages for the
 * site, and the reverse trip that opens a repository as a project.
 */

import { isIgnoredPath } from "../sandbox/types.ts";
import type { FileMap } from "../workspace/changes.ts";
import { FILE_LIMIT, TREE_LIMIT } from "../workspace/types.ts";
import { type GitHubClient, GitHubError, type Repository } from "./api.ts";
import {
  filesHoldingSecrets,
  type ProjectKind,
  pagesWorkflow,
  planPush,
  projectKind,
  workflowPath,
} from "./git.ts";

const encoder = new TextEncoder();

/** How a project is tied to a repository. Lives in localStorage per project. */
export type GitHubLink = Repository & {
  /** Where the published site lives, once Pages is on. */
  siteUrl?: string;
  /** How the site is built; set on the first publish. */
  kind?: ProjectKind;
  pushedAt?: string;
  /** Push after every agent turn. */
  auto: boolean;
};

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size)
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return results;
}

export type PushResult = { sha: string; uploaded: number; files: number; unchanged: boolean };

/**
 * Push `current` as one commit on top of the branch head. `previous` is the
 * snapshot of the last push (or empty), used to skip blobs GitHub already has.
 */
export async function pushSnapshot(
  client: GitHubClient,
  repo: Repository,
  previous: FileMap,
  current: FileMap,
  message: string,
  secrets: Record<string, string> = {},
): Promise<PushResult> {
  const leaking = filesHoldingSecrets(current, secrets);
  if (leaking.length)
    throw new Error(
      `Not pushed: ${leaking.join(", ")} ${leaking.length === 1 ? "contains" : "contain"} a project secret's value. Secrets belong in Settings, not in files.`,
    );
  const plan = await planPush(previous, current);
  const head = await client.head(repo);
  if (head) {
    // Nothing to commit when the head's tree would be identical.
    const previousPlan = await planPush({}, previous);
    const same =
      previousPlan.entries.length === plan.entries.length &&
      previousPlan.entries.every((entry, i) => plan.entries[i]?.sha === entry.sha) &&
      previousPlan.entries.length > 0;
    if (same) return { sha: head.sha, uploaded: 0, files: plan.entries.length, unchanged: true };
  }
  if (!plan.entries.length) throw new Error("There are no files to push.");
  const upload = async (paths: string[]) =>
    inBatches(paths, 6, async (path) => {
      const data = current[path];
      if (!data) return;
      const sha = await client.createBlob(repo, data);
      const expected = plan.entries.find((entry) => entry.path === path)?.sha;
      if (expected && sha !== expected)
        throw new Error(`GitHub stored ${path} under a different id than expected.`);
    });
  await upload(plan.upload);
  let tree: string;
  try {
    tree = await client.createTree(repo, plan.entries);
  } catch (error) {
    // A blob the previous snapshot promised is not there (the repository was
    // changed elsewhere, or the record of the last push was lost): send all.
    if (!(error instanceof GitHubError && error.status === 422)) throw error;
    await upload(plan.entries.map((entry) => entry.path).filter((p) => !plan.upload.includes(p)));
    tree = await client.createTree(repo, plan.entries);
  }
  const sha = await client.createCommit(repo, message, tree, head ? [head.sha] : []);
  await client.setHead(repo, sha, !head);
  return { sha, uploaded: plan.upload.length, files: plan.entries.length, unchanged: false };
}

/**
 * The files a publish adds to the project before pushing: a workflow for
 * Vite projects, a Jekyll opt-out for static ones. Returns the additions.
 */
export function publishFiles(current: FileMap): { kind: ProjectKind; added: FileMap } {
  const kind = projectKind(current);
  const added: FileMap = {};
  if (kind === "vite") {
    if (!current[workflowPath])
      added[workflowPath] = encoder.encode(
        pagesWorkflow({ pnpm: Boolean(current["pnpm-lock.yaml"]) }),
      );
  } else if (!current[".nojekyll"]) added[".nojekyll"] = new Uint8Array();
  return { kind, added };
}

/** Turn Pages on for the repository in the way the project needs. */
export async function enableSite(client: GitHubClient, repo: Repository, kind: ProjectKind) {
  return client.enablePages(repo, kind === "vite" ? "workflow" : "legacy");
}

export type SiteState = { state: "building" | "live" | "failed"; detail?: string };

/** One look at whether the site has caught up with a commit. */
export async function siteState(
  client: GitHubClient,
  repo: Repository,
  kind: ProjectKind,
  sha: string,
): Promise<SiteState> {
  if (kind === "vite") {
    const run = await client.workflowRun(repo, sha);
    if (run?.status !== "completed") return { state: "building" };
    return run.conclusion === "success"
      ? { state: "live" }
      : {
          state: "failed",
          detail: `The build failed on GitHub (${run.conclusion}). See ${run.url}`,
        };
  }
  const build = await client.latestPagesBuild(repo);
  if (!build || build.commit !== sha) return { state: "building" };
  if (build.status === "built") return { state: "live" };
  if (build.status === "errored")
    return { state: "failed", detail: `GitHub Pages could not build the site: ${build.error}` };
  return { state: "building" };
}

/** All project files of a repository, for opening it as a project. */
export async function importRepository(
  client: GitHubClient,
  repo: Repository,
  onProgress?: (done: number, total: number) => void,
): Promise<FileMap> {
  const { entries, truncated } = await client.tree(repo);
  if (truncated) throw new Error("This repository is too large to open here.");
  const wanted = entries.filter((entry) => !isIgnoredPath(entry.path) && entry.size <= FILE_LIMIT);
  const total = wanted.reduce((sum, entry) => sum + entry.size, 0);
  if (total > TREE_LIMIT) throw new Error("This repository is too large to open here.");
  const files: FileMap = {};
  let done = 0;
  await inBatches(wanted, 6, async (entry) => {
    try {
      files[entry.path] = await client.blob(repo, entry.sha);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return;
      throw error;
    }
    done++;
    onProgress?.(done, wanted.length);
  });
  return files;
}
