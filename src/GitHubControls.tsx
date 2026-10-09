import { ChevronDown, CloudUpload, ExternalLink, Globe, RefreshCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useDismiss } from "./components.tsx";
import { GitHubConnect } from "./GitHubConnect.tsx";
import { useGitHubAccount } from "./github/account.ts";
import { type GitHubProject, NeedsAccount } from "./github/use-github-project.ts";

const backUpReason =
  "Backing up puts this project in a public GitHub repository under your account, so it survives this browser.";
const publishReason =
  "Publishing puts this project in a public GitHub repository and serves it with GitHub Pages.";
const signInAgainReason =
  "GitHub no longer accepts the earlier sign-in. Sign in again to keep backing this project up.";

function describe(error: unknown) {
  return error instanceof Error ? error.message : "GitHub request failed.";
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(iso: string) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes > -1) return "just now";
  if (minutes > -60) return relative.format(minutes, "minute");
  if (minutes > -60 * 24) return relative.format(Math.round(minutes / 60), "hour");
  return relative.format(Math.round(minutes / (60 * 24)), "day");
}

/**
 * Publish, in the workspace header. The first click connects GitHub and
 * creates the repository; once the site exists it opens a menu with the
 * site, the build state and Republish.
 */
export function PublishButton({
  github,
  clientId,
  disabled,
  onError,
}: {
  github: GitHubProject;
  clientId: string;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMenuOpen(false), []);
  useDismiss(root, menuOpen, close);
  const { link, busy, site } = github;

  async function publish() {
    setMenuOpen(false);
    try {
      await github.publish();
    } catch (error) {
      if (error instanceof NeedsAccount) setConnecting(true);
      else onError(describe(error));
    }
  }

  const connect = connecting && (
    <GitHubConnect
      clientId={clientId}
      reason={publishReason}
      onConnected={() => {
        setConnecting(false);
        void publish();
      }}
      onClose={() => setConnecting(false)}
    />
  );

  if (!link?.siteUrl)
    return (
      <>
        <button
          type="button"
          className="button small primary"
          disabled={disabled || busy !== null}
          title="Publish the project as a website with GitHub Pages"
          onClick={() => void publish()}
        >
          <Globe size={14} aria-hidden="true" />
          {busy === "publishing" ? "Publishing…" : "Publish"}
        </button>
        {connect}
      </>
    );

  const state =
    busy === "publishing"
      ? "Publishing…"
      : site?.state === "building"
        ? "Building…"
        : site?.state === "failed"
          ? "Site failed"
          : "Published";
  return (
    <div className="header-menu" ref={root}>
      <button
        type="button"
        className="button small"
        data-tone={site?.state === "failed" ? "warning" : undefined}
        aria-expanded={menuOpen}
        aria-haspopup="true"
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <Globe size={14} aria-hidden="true" />
        {state}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div className="header-menu-panel" hidden={!menuOpen}>
        <a
          className="header-menu-item"
          href={link.siteUrl}
          target="_blank"
          rel="noreferrer"
          onClick={close}
        >
          <ExternalLink size={15} aria-hidden="true" /> Open site
        </a>
        <button
          type="button"
          className="header-menu-item"
          disabled={disabled || busy !== null}
          onClick={() => void publish()}
        >
          <RefreshCw size={15} aria-hidden="true" /> Republish
        </button>
        <p className="header-menu-note">
          {site?.state === "failed" && site.detail ? `${site.detail} ` : ""}
          <a href={link.htmlUrl} target="_blank" rel="noreferrer">
            {link.owner}/{link.name}
          </a>
        </p>
      </div>
      {connect}
    </div>
  );
}

/** Where this project is kept, at the top of Changes, with Back up. */
export function BackupBar({
  github,
  clientId,
  disabled,
  onError,
}: {
  github: GitHubProject;
  clientId: string;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const account = useGitHubAccount();
  const [connecting, setConnecting] = useState(false);
  const { link, busy } = github;

  async function backUp() {
    try {
      await github.backUp("Update from Sparkbox");
    } catch (error) {
      if (error instanceof NeedsAccount) setConnecting(true);
      else onError(describe(error));
    }
  }

  const repo = link && (
    <a href={link.htmlUrl} target="_blank" rel="noreferrer">
      {link.owner}/{link.name}
    </a>
  );
  return (
    <div className="backup-bar" data-tone={link && account ? undefined : "warning"}>
      <p>
        {!link ? (
          "Only in this browser, which can clear its storage without warning."
        ) : account === null ? (
          <>Sign in to GitHub again to back up to {repo}.</>
        ) : (
          <>
            Backs up to {repo}
            {link.pushedAt && <span className="backup-when"> · {ago(link.pushedAt)}</span>}
          </>
        )}
      </p>
      <button
        type="button"
        className={`button small${link ? "" : " primary"}`}
        disabled={disabled || busy !== null}
        title={
          link
            ? `Commit everything and push it to ${link.owner}/${link.name}`
            : "Create a GitHub repository for this project and push the files"
        }
        onClick={() => void backUp()}
      >
        <CloudUpload size={14} aria-hidden="true" />
        {busy === "backing-up"
          ? "Backing up…"
          : link && account === null
            ? "Sign in to GitHub again"
            : link
              ? "Back up now"
              : "Back up to GitHub"}
      </button>
      {connecting && (
        <GitHubConnect
          clientId={clientId}
          reason={link && account === null ? signInAgainReason : backUpReason}
          onConnected={() => {
            setConnecting(false);
            void backUp();
          }}
          onClose={() => setConnecting(false)}
        />
      )}
    </div>
  );
}
