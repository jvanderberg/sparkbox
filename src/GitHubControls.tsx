import { CloudUpload, ExternalLink, Globe } from "lucide-react";
import { useState } from "react";
import { Badge } from "./components.tsx";
import { GitHubConnect } from "./GitHubConnect.tsx";
import { useGitHubAccount } from "./github/account.ts";
import { type GitHubProject, NeedsAccount } from "./github/use-github-project.ts";

/**
 * Back up and Publish, in the workspace header. Each is one click: the
 * first click on either connects GitHub and creates the repository.
 */
export function GitHubControls({
  github,
  clientId,
  disabled,
  changed,
  onError,
}: {
  github: GitHubProject;
  clientId: string;
  disabled: boolean;
  /** Files changed since the last backup. */
  changed: number;
  onError: (message: string) => void;
}) {
  const account = useGitHubAccount();
  const [connecting, setConnecting] = useState<null | "backUp" | "publish">(null);
  const { link, busy, site } = github;

  async function attempt(action: "backUp" | "publish") {
    try {
      if (action === "backUp") await github.backUp("Update from Sparkbox");
      else await github.publish();
    } catch (error) {
      if (error instanceof NeedsAccount) setConnecting(action);
      else onError(error instanceof Error ? error.message : "GitHub request failed.");
    }
  }

  const backedUp = link?.pushedAt && changed === 0;
  return (
    <>
      <button
        type="button"
        className={`button small${link ? "" : " primary"}`}
        disabled={disabled || busy !== null}
        title={
          link
            ? backedUp
              ? `Everything is backed up to ${link.htmlUrl}`
              : `Push the project to ${link.owner}/${link.name}`
            : "Create a GitHub repository for this project and push the files"
        }
        onClick={() => void attempt("backUp")}
      >
        <CloudUpload size={14} aria-hidden="true" />
        {busy === "backing-up"
          ? "Backing up…"
          : link
            ? backedUp
              ? "Backed up"
              : changed
                ? `Back up (${changed})`
                : "Back up"
            : "Back up to GitHub"}
      </button>
      <button
        type="button"
        className="button small"
        disabled={disabled || busy !== null}
        title={
          link?.siteUrl
            ? "Push and rebuild the published site"
            : "Publish the project as a website with GitHub Pages"
        }
        onClick={() => void attempt("publish")}
      >
        <Globe size={14} aria-hidden="true" />
        {busy === "publishing" ? "Publishing…" : link?.siteUrl ? "Republish" : "Publish"}
      </button>
      {link?.siteUrl && (
        <a className="button small" href={link.siteUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={14} aria-hidden="true" /> Open site
        </a>
      )}
      {site?.state === "building" && <Badge tone="amber">Building site</Badge>}
      {site?.state === "failed" && <Badge tone="amber">Site build failed</Badge>}
      {connecting && (
        <GitHubConnect
          clientId={clientId}
          reason={
            connecting === "publish"
              ? "Publishing puts this project in a public GitHub repository and serves it with GitHub Pages."
              : "Backing up puts this project in a public GitHub repository under your account, so it survives this browser."
          }
          onConnected={() => {
            const action = connecting;
            setConnecting(null);
            void attempt(action);
          }}
          onClose={() => setConnecting(null)}
        />
      )}
      {account === null && link && (
        <span className="workspace-privacy">Sign in to GitHub again to back up</span>
      )}
    </>
  );
}
