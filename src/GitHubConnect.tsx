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
  const [error, setError] = useState("");
  const [pasting, setPasting] = useState(!clientId);

  async function connect(fn: () => Promise<string>) {
    setBusy(true);
    setError("");
    try {
      const login = await githubAccount.connect(await fn());
      onConnected(login);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to GitHub.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Connect GitHub" onClose={onClose}>
      <form
        className="modal-body github-connect"
        onSubmit={(event) => {
          event.preventDefault();
          void connect(async () => token);
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
            onClick={() => void connect(() => beginGitHubLogin(clientId))}
          >
            {busy ? "Waiting for GitHub…" : "Sign in with GitHub"}
          </button>
        )}
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
