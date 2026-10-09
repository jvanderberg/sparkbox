/**
 * Backing up and publishing one project on top of its git repository:
 * commit everything, push when GitHub is connected, turn Pages on, watch
 * the build, and do the commit-and-push after every agent turn.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRunner } from "../agent/runner.ts";
import { githubLinkEvent, settings } from "../agent/settings.ts";
import { describeGitError, type Repository as Git } from "../git/repo.ts";
import type { WasmerSandbox } from "../sandbox/wasmer.ts";
import { forgetIfExpired, githubAccount } from "./account.ts";
import { commitMessage, filesHoldingSecrets, repositoryName } from "./git.ts";
import { siteStatus } from "./site-status.ts";
import {
  cloneUrl,
  enableSite,
  type GitHubLink,
  publishFiles,
  type SiteState,
  siteState,
} from "./sync.ts";

export class NeedsAccount extends Error {
  constructor() {
    super("Connect GitHub first.");
  }
}

export type GitHubProject = {
  link: GitHubLink | null;
  busy: "backing-up" | "publishing" | null;
  site: SiteState | null;
  /** Commit everything with `message`; push when a repository is linked (creating it on the first call). */
  backUp: (message: string) => Promise<void>;
  /** Commit, push, turn on Pages, and watch the build. */
  publish: () => Promise<void>;
  setAuto: (auto: boolean) => void;
  unlink: () => void;
};

export function useGitHubProject(options: {
  project: { id: string; name: string };
  sandbox: WasmerSandbox;
  git: Git;
  runner: AgentRunner;
  secrets: () => Record<string, string>;
  /** Called after every commit or push, so the Changes view refreshes. */
  onChanged: () => void;
  report: (message: string, error?: boolean) => void;
}): GitHubProject {
  const { project, sandbox, git, runner, secrets, onChanged, report } = options;
  const [link, setLinkState] = useState<GitHubLink | null>(() => settings.githubLink(project.id));
  const [busy, setBusy] = useState<GitHubProject["busy"]>(null);
  const [site, setSiteState] = useState<SiteState | null>(() => siteStatus.get(project.id) ?? null);
  const linkRef = useRef(link);
  linkRef.current = link;
  const working = useRef<Promise<void> | null>(null);
  const watching = useRef(0);

  const setSite = useCallback(
    (state: SiteState | null) => {
      siteStatus.set(project.id, state);
      setSiteState(state);
    },
    [project.id],
  );

  const setLink = useCallback(
    (next: GitHubLink | null) => {
      linkRef.current = next;
      setLinkState(next);
      settings.setGithubLink(project.id, next);
    },
    [project.id],
  );
  // Settings can change the link (auto-backup, forget) while the workspace is open.
  useEffect(() => {
    const onChange = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== project.id) return;
      const next = settings.githubLink(project.id);
      linkRef.current = next;
      setLinkState(next);
    };
    window.addEventListener(githubLinkEvent, onChange);
    return () => window.removeEventListener(githubLinkEvent, onChange);
  }, [project.id]);

  /** Keep looking at GitHub until the site reflects `sha`. */
  const watchSite = useCallback(
    async (sha: string) => {
      const current = linkRef.current;
      const client = githubAccount.client();
      if (!current?.siteUrl || !current.kind || !client) return;
      const token = ++watching.current;
      setSite({ state: "building" });
      const deadline = Date.now() + 6 * 60_000;
      while (Date.now() < deadline && watching.current === token) {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        if (watching.current !== token) return;
        try {
          const state = await siteState(client, current, current.kind, sha);
          setSite(state);
          if (state.state !== "building") {
            if (state.state === "live") report(`Published: ${current.siteUrl}`);
            else report(state.detail ?? "The site did not build.", true);
            return;
          }
        } catch (error) {
          forgetIfExpired(error);
          setSite({ state: "failed", detail: error instanceof Error ? error.message : "" });
          return;
        }
      }
      if (watching.current === token)
        setSite({ state: "failed", detail: "GitHub has not finished building the site yet." });
    },
    [report, setSite],
  );

  const run = useCallback(
    async (kind: NonNullable<GitHubProject["busy"]>, task: () => Promise<void>): Promise<void> => {
      // One operation at a time; a second request waits for the first.
      while (working.current) await working.current.catch(() => {});
      setBusy(kind);
      working.current = task().finally(() => {
        working.current = null;
        setBusy(null);
      });
      try {
        await working.current;
      } catch (error) {
        forgetIfExpired(error);
        throw error;
      }
    },
    [],
  );

  /** The linked repository, created on the first call. Needs an account. */
  const ensureLink = useCallback(async (): Promise<GitHubLink> => {
    const client = githubAccount.client();
    if (!client) throw new NeedsAccount();
    const current = linkRef.current;
    if (current) {
      if ((await git.remote()) !== cloneUrl(current)) await git.setRemote(cloneUrl(current));
      return current;
    }
    const repo = await client.createRepository(
      repositoryName(project.name),
      `${project.name} — built with Sparkbox`,
    );
    await git.setRemote(cloneUrl(repo));
    // The empty repository's default branch becomes whichever branch is pushed first.
    const created: GitHubLink = { ...repo, branch: await git.currentBranch(), auto: true };
    setLink(created);
    return created;
  }, [git, project.name, setLink]);

  /** Commit everything; returns the new commit, or null when the tree was clean. */
  const commitAll = useCallback(
    async (message: string) => {
      const sha = await git.commitAll(message || "Update from Sparkbox");
      if (sha) onChanged();
      return sha;
    },
    [git, onChanged],
  );

  /** Push the branch; a diverged remote is merged first, since this app is the usual source of changes. */
  const push = useCallback(async () => {
    const leaking = filesHoldingSecrets(await sandbox.snapshot(), secrets());
    if (leaking.length)
      throw new Error(
        `Not pushed: ${leaking.join(", ")} ${leaking.length === 1 ? "contains" : "contain"} a project secret's value. Secrets belong in Settings, not in files.`,
      );
    try {
      await git.push();
    } catch (error) {
      forgetIfExpired(error);
      if (!/Pull first/.test(describeGitError(error))) throw new Error(describeGitError(error));
      try {
        await git.fetch();
        if (await git.remoteIsGitHubStarter()) await git.push({ force: true });
        else {
          await git.pull();
          onChanged();
          await git.push();
        }
      } catch (again) {
        forgetIfExpired(again);
        throw new Error(describeGitError(again));
      }
    }
    const current = linkRef.current;
    if (current) setLink({ ...current, pushedAt: new Date().toISOString() });
  }, [git, sandbox, secrets, onChanged, setLink]);

  const backUp = useCallback(
    (message: string) =>
      run("backing-up", async () => {
        const sha = await commitAll(message);
        if (!githubAccount.get() && !linkRef.current) {
          if (sha) report("Committed. Connect GitHub to keep a copy outside this browser.");
          throw new NeedsAccount();
        }
        const target = await ensureLink();
        await push();
        report(
          sha ? `Backed up to ${target.htmlUrl}` : `Everything is backed up to ${target.htmlUrl}`,
        );
        if (sha && target.siteUrl) void watchSite(sha);
      }),
    [run, commitAll, ensureLink, push, report, watchSite],
  );

  const publish = useCallback(
    () =>
      run("publishing", async () => {
        const client = githubAccount.client();
        if (!client) throw new NeedsAccount();
        const target = await ensureLink();
        const { kind, added } = publishFiles(await sandbox.snapshot());
        let siteUrl = target.siteUrl;
        if (!siteUrl || target.kind !== kind) {
          // Pages needs the branch on GitHub, and a new repository is empty.
          if (!target.pushedAt) {
            await commitAll("Update from Sparkbox");
            await push();
          }
          siteUrl = await enableSite(client, target, kind);
          setLink({ ...(linkRef.current ?? target), siteUrl, kind });
        }
        for (const [path, data] of Object.entries(added)) await sandbox.writeFile(path, data);
        const sha = (await commitAll("Publish to GitHub Pages")) ?? (await git.head());
        await push();
        if (kind === "static") await client.requestPagesBuild(target).catch(() => {});
        report(`Publishing to ${siteUrl}…`);
        if (sha) void watchSite(sha);
      }),
    [run, ensureLink, sandbox, commitAll, git, push, setLink, report, watchSite],
  );

  // After every successful agent turn: commit with the prompt as the message,
  // and push when the project is on GitHub.
  const lastPrompt = useRef("");
  useEffect(() => {
    return runner.subscribe((event) => {
      if (event.type === "user") lastPrompt.current = event.text;
      if (event.type !== "done" || event.outcome !== "success") return;
      const current = linkRef.current;
      const message = commitMessage(lastPrompt.current);
      if (current?.auto && githubAccount.get())
        void backUp(message)
          .then(() => siteStatus.recordBackup(project.id, { ok: true }))
          .catch((error: Error) => {
            siteStatus.recordBackup(project.id, { ok: false, error: error.message });
            report(`Automatic backup failed: ${error.message}`, true);
          });
      else
        void run("backing-up", async () => {
          await commitAll(message);
        }).catch((error: Error) => report(`Automatic commit failed: ${error.message}`, true));
    });
  }, [runner, backUp, run, commitAll, report, project.id]);

  useEffect(
    () => () => {
      watching.current++;
    },
    [],
  );

  const setAuto = useCallback(
    (auto: boolean) => {
      if (linkRef.current) setLink({ ...linkRef.current, auto });
    },
    [setLink],
  );
  const unlink = useCallback(() => setLink(null), [setLink]);

  return { link, busy, site, backUp, publish, setAuto, unlink };
}
