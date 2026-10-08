/**
 * Backing up and publishing one project. Pushes read the sandbox's files,
 * replace the Changes baseline with what was pushed, and (when the project
 * asks for it) run after every agent turn.
 */
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import type { AgentRunner } from "../agent/runner.ts";
import { githubLinkEvent, settings } from "../agent/settings.ts";
import { saveBaseline } from "../sandbox/storage.ts";
import type { WasmerSandbox } from "../sandbox/wasmer.ts";
import type { FileMap } from "../workspace/changes.ts";
import { forgetIfExpired, githubAccount } from "./account.ts";
import { commitMessage, repositoryName } from "./git.ts";
import {
  enableSite,
  type GitHubLink,
  publishFiles,
  pushSnapshot,
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
  /** Push the project; creates the repository on the first call. */
  backUp: (message: string) => Promise<void>;
  /** Push, turn on Pages, and wait for the site. */
  publish: () => Promise<void>;
  setAuto: (auto: boolean) => void;
  unlink: () => void;
};

export function useGitHubProject(options: {
  project: { id: string; name: string };
  sandbox: WasmerSandbox;
  runner: AgentRunner;
  secrets: () => Record<string, string>;
  /** The Changes baseline; replaced by every push. */
  baseline: MutableRefObject<FileMap | null>;
  onPushed: (snapshot: FileMap) => void;
  report: (message: string, error?: boolean) => void;
}): GitHubProject {
  const { project, sandbox, runner, secrets, baseline, onPushed, report } = options;
  const [link, setLinkState] = useState<GitHubLink | null>(() => settings.githubLink(project.id));
  const [busy, setBusy] = useState<GitHubProject["busy"]>(null);
  const [site, setSite] = useState<SiteState | null>(null);
  const linkRef = useRef(link);
  linkRef.current = link;
  const working = useRef<Promise<void> | null>(null);
  const watching = useRef(0);

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
    [report],
  );

  const run = useCallback(
    async (kind: NonNullable<GitHubProject["busy"]>, task: () => Promise<void>): Promise<void> => {
      // One push at a time; a second request waits for the first.
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

  const ensureLink = useCallback(async (): Promise<GitHubLink> => {
    const client = githubAccount.client();
    if (!client) throw new NeedsAccount();
    const current = linkRef.current;
    if (current) return current;
    const repo = await client.createRepository(
      repositoryName(project.name),
      `${project.name} — built with Sparkbox`,
    );
    const created: GitHubLink = { ...repo, auto: true };
    setLink(created);
    return created;
  }, [project.name, setLink]);

  const push = useCallback(
    async (message: string, extra?: FileMap): Promise<{ sha: string; unchanged: boolean }> => {
      const client = githubAccount.client();
      if (!client) throw new NeedsAccount();
      const target = await ensureLink();
      for (const [path, data] of Object.entries(extra ?? {})) await sandbox.writeFile(path, data);
      const snapshot = await sandbox.snapshot();
      // Before the first push nothing is on GitHub, whatever Save version recorded.
      const previous = target.pushedAt ? (baseline.current ?? {}) : {};
      const result = await pushSnapshot(client, target, previous, snapshot, message, secrets());
      if (!result.unchanged || !target.pushedAt) {
        await saveBaseline(project.id, snapshot);
        baseline.current = snapshot;
        onPushed(snapshot);
        setLink({ ...(linkRef.current ?? target), pushedAt: new Date().toISOString() });
      }
      return result;
    },
    [ensureLink, sandbox, baseline, secrets, project.id, onPushed, setLink],
  );

  const backUp = useCallback(
    (message: string) =>
      run("backing-up", async () => {
        const result = await push(message || "Update from Sparkbox");
        const target = linkRef.current;
        if (!target) return;
        if (result.unchanged) report(`Everything is already backed up to ${target.htmlUrl}`);
        else report(`Backed up to ${target.htmlUrl}`);
        if (!result.unchanged && target.siteUrl) void watchSite(result.sha);
      }),
    [run, push, report, watchSite],
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
          siteUrl = await enableSite(client, target, kind);
          setLink({ ...(linkRef.current ?? target), siteUrl, kind });
        }
        const result = await push("Publish to GitHub Pages", added);
        if (kind === "static") await client.requestPagesBuild(target).catch(() => {});
        report(`Publishing to ${siteUrl}…`);
        void watchSite(result.sha);
      }),
    [run, ensureLink, sandbox, push, setLink, report, watchSite],
  );

  // After every successful agent turn, push with the prompt as the message.
  const lastPrompt = useRef("");
  useEffect(() => {
    return runner.subscribe((event) => {
      if (event.type === "user") lastPrompt.current = event.text;
      if (event.type !== "done" || event.outcome !== "success") return;
      const current = linkRef.current;
      if (!current?.auto || !githubAccount.get()) return;
      void backUp(commitMessage(lastPrompt.current)).catch((error: Error) =>
        report(`Automatic backup failed: ${error.message}`, true),
      );
    });
  }, [runner, backUp, report]);

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
