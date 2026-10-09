/**
 * The agent's github tool and the GitHub lines of its prompt, built from
 * the project's link, the signed-in account and the page's repository.
 */
import type { GitHubController, GitHubState } from "../agent/github-controller.ts";
import { settings } from "../agent/settings.ts";
import type { Repository as Git } from "../git/repo.ts";
import { forgetIfExpired, githubAccount } from "./account.ts";
import { siteStatus } from "./site-status.ts";

export function createGitHubController(options: {
  project: string;
  git: () => Git | null;
  relayUrl: () => string;
}): { controller: GitHubController; state: () => GitHubState } {
  const link = () => settings.githubLink(options.project);
  const client = () => githubAccount.client();

  const state = (): GitHubState => {
    const current = link();
    return {
      connected: Boolean(githubAccount.get()),
      repository: current ? `${current.owner}/${current.name}` : undefined,
      siteUrl: current?.siteUrl,
      lastBuild: siteStatus.get(options.project),
      autoBackup: Boolean(current?.auto && githubAccount.get()),
      lastBackup: siteStatus.lastBackup(options.project),
    };
  };

  const controller: GitHubController = {
    async status() {
      const current = link();
      const account = githubAccount.get();
      const lines: string[] = [];
      lines.push(account ? `GitHub: connected as ${account.login}.` : "GitHub: not connected.");
      if (!account && !current)
        lines.push(
          'The user can connect by clicking "Back up to GitHub" in the header; that also creates the repository.',
        );
      if (current) {
        lines.push(`Repository: ${current.htmlUrl} (origin; branch ${current.branch}).`);
        lines.push(current.siteUrl ? `Site: ${current.siteUrl}` : "Site: not published yet.");
        if (current.pushedAt) lines.push(`Last push: ${current.pushedAt}.`);
        lines.push(
          current.auto && account
            ? "Automatic backup: on. Sparkbox commits and pushes when your turn ends; do not offer to push."
            : "Automatic backup: off. git push works when the user asks.",
        );
        const backup = siteStatus.lastBackup(options.project);
        if (backup)
          lines.push(
            backup.ok
              ? `Last automatic backup succeeded at ${backup.at}.`
              : `Last automatic backup FAILED at ${backup.at}: ${backup.error ?? "unknown error"}`,
          );
      } else if (account)
        lines.push(
          'No repository yet: the user\'s first click on "Back up" or "Publish" creates one.',
        );
      const git = options.git();
      if (git) {
        const changes = await git.changes();
        const head = await git.log(1);
        lines.push(
          head[0]
            ? `HEAD: ${head[0].sha.slice(0, 7)} ${head[0].message.split("\n")[0]}`
            : "No commits yet.",
        );
        lines.push(
          changes.files.length
            ? `Uncommitted changes: ${changes.files.map((file) => file.path).join(", ")}`
            : "Working tree clean.",
        );
      }
      const build = siteStatus.get(options.project);
      if (build)
        lines.push(
          build.state === "failed"
            ? `Last build: FAILED. ${build.detail ?? ""}`.trim()
            : build.state === "building"
              ? "Last build: still running on GitHub."
              : "Last build: succeeded.",
        );
      return lines.join("\n");
    },
    async runs() {
      const current = link();
      const api = client();
      if (!current) return "No repository is linked to this project yet.";
      if (!api) return "GitHub is not connected; sign in from Settings.";
      try {
        const runs = await api.workflowRuns(current, 8);
        if (!runs.length) return "No GitHub Actions runs yet (static sites build without Actions).";
        return runs
          .map(
            (run) =>
              `#${run.id}  ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}  ${run.sha.slice(0, 7)}  ${run.message}  ${run.createdAt}  ${run.url}`,
          )
          .join("\n");
      } catch (error) {
        forgetIfExpired(error);
        throw error;
      }
    },
    async logs(runId) {
      const current = link();
      const api = client();
      if (!current) return "No repository is linked to this project yet.";
      if (!api) return "GitHub is not connected; sign in from Settings.";
      try {
        let id = runId;
        if (!id) {
          const runs = await api.workflowRuns(current, 10);
          const failed = runs.find((run) => run.conclusion && run.conclusion !== "success");
          if (!failed) {
            if (!runs.length) {
              const pages = await api.latestPagesBuild(current);
              return pages
                ? `No Actions runs. Last Pages build: ${pages.status}${pages.error ? ` (${pages.error})` : ""} for ${pages.commit.slice(0, 7)}.`
                : "No builds have run yet.";
            }
            return `No failed run among the last ${runs.length}; the latest is ${runs[0]?.status}${runs[0]?.conclusion ? `/${runs[0].conclusion}` : ""} (#${runs[0]?.id}).`;
          }
          id = failed.id;
        }
        const jobs = await api.jobs(current, id);
        const lines: string[] = [`Run #${id}`];
        let failedJob: (typeof jobs)[number] | undefined;
        for (const job of jobs) {
          lines.push(`Job ${job.name}: ${job.conclusion ?? "in progress"}`);
          for (const step of job.steps)
            if (step.conclusion && step.conclusion !== "success" && step.conclusion !== "skipped")
              lines.push(`  step "${step.name}": ${step.conclusion}`);
          if (!failedJob && job.conclusion && job.conclusion !== "success") failedJob = job;
        }
        const relay = options.relayUrl();
        if (failedJob && relay) {
          const text = await api.jobLogs(current, failedJob.id, relay);
          const all = text.split("\n");
          const firstError = all.findIndex((line) =>
            /##\[error\]|error TS|ERROR|Error:|failed/i.test(line),
          );
          const start = Math.max(0, (firstError >= 0 ? firstError : all.length) - 40);
          const tail = all.slice(start, start + 200).map((line) => line.replace(/^\S+T\S+Z /, ""));
          lines.push("", `Log of ${failedJob.name} (around the first error):`, ...tail);
        } else if (failedJob)
          lines.push("", "Log text needs the Sparkbox host; see the run on GitHub.");
        return lines.join("\n");
      } catch (error) {
        forgetIfExpired(error);
        throw error;
      }
    },
  };
  return { controller, state };
}
