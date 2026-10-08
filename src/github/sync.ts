/**
 * Publishing a project: the files a site needs, turning Pages on, and
 * watching GitHub until the site reflects a commit. Pushes themselves are
 * git (see src/git/repo.ts).
 */
import type { FileMap } from "../workspace/changes.ts";
import type { GitHubClient, Repository } from "./api.ts";
import { type ProjectKind, pagesWorkflow, projectKind, workflowPath } from "./git.ts";

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

/** The clone URL git uses for a repository. */
export function cloneUrl(repo: Repository) {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
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
