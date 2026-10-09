import { Settings } from "lucide-react";
import { useState } from "react";
import { invite } from "./invite.ts";

/**
 * What shows before anything else when the host hands out invites and this
 * browser holds none. Without one the sandbox has no network, so packages do
 * not install and the preview of most projects cannot start.
 */
export function InviteGate({ onSettings }: { onSettings: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const expired = invite.expired();
  return (
    <main className="landing">
      <header className="landing-header">
        <span />
        <button type="button" className="header-icon" aria-label="Settings" onClick={onSettings}>
          <Settings size={18} aria-hidden="true" />
        </button>
      </header>
      <section className="landing-body">
        <h1>Sparkbox</h1>
        <p>Describe an app and an AI agent builds it, with a live preview as it goes.</p>
        <form
          className="project-create"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            invite
              .redeem(code)
              .catch((cause: Error) => setError(cause.message))
              .finally(() => setBusy(false));
          }}
        >
          <input
            aria-label="Invite code"
            placeholder="Invite code"
            autoComplete="off"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <button type="submit" className="button primary" disabled={busy || !code.trim()}>
            {busy ? "Checking…" : "Continue"}
          </button>
        </form>
        <p className="form-error invite-error" role="alert" hidden={!error}>
          {error}
        </p>
        {expired && (
          <p className="landing-alternative">
            Your invite has expired. Enter the code again to keep going.
          </p>
        )}
      </section>
    </main>
  );
}
