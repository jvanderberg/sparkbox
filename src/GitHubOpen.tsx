import { useEffect, useState } from "react";
import { Modal } from "./components.tsx";
import { forgetIfExpired, githubAccount } from "./github/account.ts";
import type { Repository } from "./github/api.ts";

type Listed = Repository & { description: string; updatedAt: string; fork: boolean };

/**
 * Open one of the account's repositories as a project: the files come down
 * through the API into this browser and the project stays linked, so the
 * next backup pushes to the same place.
 */
export function GitHubOpen({
  onOpen,
  onConnect,
  onClose,
}: {
  onOpen: (repo: Repository) => Promise<void>;
  /** Open the sign-in dialog, when GitHub no longer accepts the token. */
  onConnect: () => void;
  onClose: () => void;
}) {
  const [repos, setRepos] = useState<Listed[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const client = githubAccount.client();
    if (!client) {
      setError("Connect GitHub first.");
      return;
    }
    client
      .listRepositories()
      .then((list) => setRepos(list.filter((repo) => !repo.fork)))
      .catch((cause: Error) => {
        forgetIfExpired(cause);
        setError(cause.message);
      });
  }, []);

  async function open(repo: Listed) {
    setBusy(repo.name);
    setError("");
    try {
      await onOpen(repo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the repository.");
      setBusy(null);
    }
  }

  const shown = repos?.filter((repo) =>
    `${repo.name} ${repo.description}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <Modal title="Open from GitHub" onClose={onClose}>
      <div className="modal-body github-open">
        <p className="muted">
          Your repositories, newest first. Opening one clones it into this browser as a project that
          backs up to the same repository.
        </p>
        <input
          aria-label="Filter repositories"
          placeholder="Filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          disabled={!repos}
        />
        {!repos && !error && <p className="muted">Loading repositories…</p>}
        {shown && shown.length === 0 && <p className="muted">No repositories match.</p>}
        <ul className="project-list">
          {shown?.map((repo) => (
            <li key={`${repo.owner}/${repo.name}`}>
              <button
                type="button"
                className="project-open"
                disabled={busy !== null}
                onClick={() => void open(repo)}
              >
                {repo.name}
                {repo.description && <span className="github-repo-note">{repo.description}</span>}
                {busy === repo.name && <span className="github-repo-note">Opening…</span>}
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {error && /sign-in|Connect GitHub/i.test(error) && (
          <div className="form-actions">
            <button type="button" className="button primary" onClick={onConnect}>
              Sign in to GitHub
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
