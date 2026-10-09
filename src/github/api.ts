/**
 * The slice of GitHub's REST API that backing up and publishing needs. The
 * API allows browser requests, so everything here runs in the page with the
 * user's token; the token goes to api.github.com and nowhere else.
 */

export type Repository = {
  owner: string;
  name: string;
  branch: string;
  htmlUrl: string;
};

export type TreeEntry = { path: string; sha: string; size: number };

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const api = "https://api.github.com";

function base64(data: Uint8Array) {
  let binary = "";
  for (let i = 0; i < data.length; i += 8192)
    binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(binary);
}

function repoPath(repo: Repository, suffix = "") {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

function describe(status: number, body: unknown) {
  const data = body as { message?: string; errors?: { message?: string }[] } | null;
  const detail = data?.errors?.map((entry) => entry.message).filter(Boolean)[0];
  const message = data?.message ?? "";
  if (status === 401)
    return "GitHub no longer accepts this sign-in. Sign in again from the project header or Settings.";
  if (status === 403 && /rate limit/i.test(message))
    return "GitHub's rate limit is reached for this account. Try again in a while.";
  if (status === 403 || status === 404)
    return `GitHub refused (${status}): ${detail ?? message ?? "no access"}. The sign-in may lack repository access.`;
  return `GitHub returned ${status}${detail ? `: ${detail}` : message ? `: ${message}` : ""}.`;
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { accept?: string; raw?: boolean } = {},
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: options.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchFn(`${api}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (options.raw) {
      if (!response.ok) throw new GitHubError(describe(response.status, null), response.status);
      return {
        status: response.status,
        data: new Uint8Array(await response.arrayBuffer()) as unknown as T,
      };
    }
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) throw new GitHubError(describe(response.status, data), response.status);
    return { status: response.status, data: data as T };
  }

  async user(): Promise<{ login: string }> {
    const { data } = await this.request<{ login: string }>("GET", "/user");
    return { login: data.login };
  }

  async repository(owner: string, name: string): Promise<Repository | null> {
    try {
      const { data } = await this.request<{
        owner: { login: string };
        name: string;
        default_branch: string;
        html_url: string;
      }>("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
      return {
        owner: data.owner.login,
        name: data.name,
        branch: data.default_branch,
        htmlUrl: data.html_url,
      };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * A new public repository with an initial commit, so the first push has a
   * parent. A taken name gets a numeric suffix rather than a question.
   */
  async createRepository(name: string, description: string): Promise<Repository> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = attempt ? `${name}-${attempt + 1}` : name;
      try {
        const { data } = await this.request<{
          owner: { login: string };
          name: string;
          default_branch: string;
          html_url: string;
        }>("POST", "/user/repos", {
          name: candidate,
          description,
          private: false,
          auto_init: true,
          has_wiki: false,
          has_projects: false,
        });
        return {
          owner: data.owner.login,
          name: data.name,
          branch: data.default_branch,
          htmlUrl: data.html_url,
        };
      } catch (error) {
        if (error instanceof GitHubError && error.status === 422 && /exists/i.test(error.message))
          continue;
        throw error;
      }
    }
    throw new GitHubError(`Could not find a free repository name for ${name}.`, 422);
  }

  async head(repo: Repository): Promise<{ sha: string; tree: string } | null> {
    try {
      const { data } = await this.request<{ object: { sha: string } }>(
        "GET",
        repoPath(repo, `/git/ref/heads/${encodeURIComponent(repo.branch)}`),
      );
      const commit = await this.request<{ tree: { sha: string } }>(
        "GET",
        repoPath(repo, `/git/commits/${data.object.sha}`),
      );
      return { sha: data.object.sha, tree: commit.data.tree.sha };
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 404 || error.status === 409))
        return null;
      throw error;
    }
  }

  async createBlob(repo: Repository, data: Uint8Array): Promise<string> {
    const result = await this.request<{ sha: string }>("POST", repoPath(repo, "/git/blobs"), {
      content: base64(data),
      encoding: "base64",
    });
    return result.data.sha;
  }

  async createTree(repo: Repository, entries: { path: string; sha: string }[]): Promise<string> {
    const result = await this.request<{ sha: string }>("POST", repoPath(repo, "/git/trees"), {
      tree: entries.map((entry) => ({
        path: entry.path,
        mode: "100644",
        type: "blob",
        sha: entry.sha,
      })),
    });
    return result.data.sha;
  }

  async createCommit(
    repo: Repository,
    message: string,
    tree: string,
    parents: string[],
  ): Promise<string> {
    const result = await this.request<{ sha: string }>("POST", repoPath(repo, "/git/commits"), {
      message,
      tree,
      parents,
    });
    return result.data.sha;
  }

  async setHead(repo: Repository, sha: string, create: boolean): Promise<void> {
    if (create) {
      await this.request("POST", repoPath(repo, "/git/refs"), {
        ref: `refs/heads/${repo.branch}`,
        sha,
      });
      return;
    }
    await this.request(
      "PATCH",
      repoPath(repo, `/git/refs/heads/${encodeURIComponent(repo.branch)}`),
      {
        sha,
        force: false,
      },
    );
  }

  async pages(repo: Repository): Promise<{ url: string; status: string | null } | null> {
    try {
      const { data } = await this.request<{ html_url: string; status: string | null }>(
        "GET",
        repoPath(repo, "/pages"),
      );
      return { url: data.html_url, status: data.status };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /** Turn Pages on (or switch its build type) and return the site URL. */
  async enablePages(repo: Repository, buildType: "legacy" | "workflow"): Promise<string> {
    const body = { build_type: buildType, source: { branch: repo.branch, path: "/" } };
    try {
      const { data } = await this.request<{ html_url: string }>(
        "POST",
        repoPath(repo, "/pages"),
        body,
      );
      return data.html_url;
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 409)) throw error;
    }
    await this.request("PUT", repoPath(repo, "/pages"), body);
    const current = await this.pages(repo);
    if (!current) throw new GitHubError("GitHub Pages did not report a site URL.", 500);
    return current.url;
  }

  /** The newest Actions run for a commit, if one has started. */
  async workflowRun(
    repo: Repository,
    sha: string,
  ): Promise<{ status: string; conclusion: string | null; url: string } | null> {
    const { data } = await this.request<{
      workflow_runs: { status: string; conclusion: string | null; html_url: string }[];
    }>("GET", repoPath(repo, `/actions/runs?per_page=1&head_sha=${encodeURIComponent(sha)}`));
    const run = data.workflow_runs[0];
    return run ? { status: run.status, conclusion: run.conclusion, url: run.html_url } : null;
  }

  /** The latest Actions runs, newest first. */
  async workflowRuns(
    repo: Repository,
    count = 5,
  ): Promise<
    {
      id: number;
      status: string;
      conclusion: string | null;
      url: string;
      message: string;
      sha: string;
      createdAt: string;
    }[]
  > {
    const { data } = await this.request<{
      workflow_runs: {
        id: number;
        status: string;
        conclusion: string | null;
        html_url: string;
        head_sha: string;
        head_commit: { message: string } | null;
        created_at: string;
      }[];
    }>("GET", repoPath(repo, `/actions/runs?per_page=${count}`));
    return data.workflow_runs.map((run) => ({
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      message: run.head_commit?.message.split("\n")[0] ?? "",
      sha: run.head_sha,
      createdAt: run.created_at,
    }));
  }

  /** The jobs of a run with their steps. */
  async jobs(
    repo: Repository,
    runId: number,
  ): Promise<
    {
      id: number;
      name: string;
      conclusion: string | null;
      steps: { name: string; conclusion: string | null }[];
    }[]
  > {
    const { data } = await this.request<{
      jobs: {
        id: number;
        name: string;
        conclusion: string | null;
        steps: { name: string; conclusion: string | null }[];
      }[];
    }>("GET", repoPath(repo, `/actions/runs/${runId}/jobs`));
    return data.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      steps: job.steps.map((step) => ({ name: step.name, conclusion: step.conclusion })),
    }));
  }

  /** A job's log text, through the host relay (GitHub serves it from a host without CORS). */
  async jobLogs(repo: Repository, jobId: number, relay: string): Promise<string> {
    const url = `${relay.replace(/\/$/, "")}/api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/actions/jobs/${jobId}/logs`;
    const response = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new GitHubError(describe(response.status, null), response.status);
    return response.text();
  }

  /** Ask Pages to build the branch now rather than on its own schedule. */
  async requestPagesBuild(repo: Repository): Promise<void> {
    await this.request("POST", repoPath(repo, "/pages/builds"));
  }

  async latestPagesBuild(
    repo: Repository,
  ): Promise<{ status: string; commit: string; error: string } | null> {
    try {
      const { data } = await this.request<{
        status: string;
        commit: string;
        error: { message: string | null };
      }>("GET", repoPath(repo, "/pages/builds/latest"));
      return { status: data.status, commit: data.commit, error: data.error?.message ?? "" };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  async listRepositories(): Promise<
    (Repository & { description: string; updatedAt: string; fork: boolean })[]
  > {
    const { data } = await this.request<
      {
        owner: { login: string };
        name: string;
        default_branch: string;
        html_url: string;
        description: string | null;
        pushed_at: string;
        fork: boolean;
      }[]
    >("GET", "/user/repos?sort=pushed&per_page=100&affiliation=owner");
    return data.map((entry) => ({
      owner: entry.owner.login,
      name: entry.name,
      branch: entry.default_branch,
      htmlUrl: entry.html_url,
      description: entry.description ?? "",
      updatedAt: entry.pushed_at,
      fork: entry.fork,
    }));
  }

  async tree(repo: Repository): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const { data } = await this.request<{
      tree: { path: string; type: string; sha: string; size?: number }[];
      truncated: boolean;
    }>("GET", repoPath(repo, `/git/trees/${encodeURIComponent(repo.branch)}?recursive=1`));
    return {
      entries: data.tree
        .filter((entry) => entry.type === "blob")
        .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 })),
      truncated: data.truncated,
    };
  }

  async blob(repo: Repository, sha: string): Promise<Uint8Array> {
    const { data } = await this.request<Uint8Array>(
      "GET",
      repoPath(repo, `/git/blobs/${sha}`),
      undefined,
      {
        accept: "application/vnd.github.raw+json",
        raw: true,
      },
    );
    return data;
  }
}
