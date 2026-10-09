import { useState } from "react";
import { Field, Modal } from "./components.tsx";
import { githubAccount } from "./github/account.ts";
import { beginGitHubLogin, scopes } from "./github/auth.ts";

export const tokenUrl = `https://github.com/settings/tokens/new?scopes=${encodeURIComponent(
  scopes.replace(" ", ","),
)}&description=Sparkbox`;

/**
 * Connect a GitHub account: one click when the host has an OAuth app, or a
 * pasted token otherwise (and as the fallback either way).
 */
export function GitHubConnect({
  clientId,
  reason,
  onConnected,
  onClose,
}: {
  clientId: string;
  /** Why the sign-in is being asked for, shown above the buttons. */
  reason: string;
  onConnected: (login: string) => void;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  // The popup is open; the button stays live in case it was closed.
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const [pasting, setPasting] = useState(!clientId);

  async function connect(token: string) {
    setBusy(true);
    setError("");
    try {
      onConnected(await githubAccount.connect(token));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to GitHub.");
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    setWaiting(true);
    setError("");
    try {
      // The popup has already verified and stored the token.
      await beginGitHubLogin(clientId);
      const account = githubAccount.get();
      if (account) onConnected(account.login);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to GitHub.");
    } finally {
      setWaiting(false);
    }
  }

  return (
    <Modal title="Connect GitHub" onClose={onClose}>
      <form
        className="modal-body github-connect"
        onSubmit={(event) => {
          event.preventDefault();
          void connect(token);
        }}
      >
        <p>{reason}</p>
        <p className="muted">
          Projects are backed up to public repositories under your account and published with GitHub
          Pages. Sparkbox keeps the sign-in in this browser only and uses it for nothing else.
        </p>
        {clientId && (
          <button
            type="button"
            className="button primary github-signin"
            disabled={busy}
            onClick={() => void signIn()}
          >
            {waiting ? "Waiting for GitHub…" : "Sign in with GitHub"}
          </button>
        )}
        <p className="muted github-waiting" hidden={!waiting}>
          Finish signing in in the GitHub window. Closed it? Click the button again.
        </p>
        {pasting ? (
          <>
            <Field label="Personal access token">
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="ghp_…"
              />
            </Field>
            <p className="muted">
              <a href={tokenUrl} target="_blank" rel="noreferrer">
                Create a token on GitHub
              </a>{" "}
              with the public_repo and workflow scopes, then paste it here.
            </p>
            <div className="form-actions">
              <button type="submit" className="button primary" disabled={busy || !token.trim()}>
                {busy ? "Checking…" : "Use token"}
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="link-button muted"
            onClick={() => setPasting(true)}
            disabled={busy}
          >
            Use a personal access token instead
          </button>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
