/**
 * Sign in with GitHub. The authorization happens on github.com in a popup
 * (so the sandbox keeps running) or, when popups are blocked, in this tab.
 * GitHub's token endpoint refuses browser requests and needs the app's
 * secret, so the code goes to the host, which swaps it for a token and keeps
 * nothing. Without a host the user pastes a token instead.
 *
 * The app is cross-origin isolated, which severs a popup from its opener as
 * soon as it visits github.com, so the popup cannot post the code back.
 * Instead the popup completes the sign-in itself and stores the token; the
 * opening tab sees it arrive through localStorage.
 */
import { settings } from "../agent/settings.ts";

const stateKey = "sparkbox:github-state";
export const scopes = "public_repo workflow";

type PendingLogin = { state: string; popup: boolean; returnTo: string; startedAt: number };

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `gh-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function readPending(): PendingLogin | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(stateKey) || "null") as PendingLogin | null;
    if (!parsed || typeof parsed.state !== "string") return null;
    // A sign-in older than ten minutes is not one the user is still waiting on.
    if (Date.now() - parsed.startedAt > 10 * 60_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePending(pending: PendingLogin | null) {
  try {
    if (pending) localStorage.setItem(stateKey, JSON.stringify(pending));
    else localStorage.removeItem(stateKey);
  } catch {
    // Without storage the state cannot be checked; the completion refuses.
  }
}

function authorizeUrl(clientId: string, state: string) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  // No redirect_uri: GitHub sends the user to the app's registered callback
  // (the site's origin), so a trailing-slash difference cannot refuse it.
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  return url.href;
}

/** Swap an authorization code for a token through the host. */
export async function exchangeCode(code: string): Promise<string> {
  const response = await fetch("/api/github/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !data.token)
    throw new Error(data.error ?? "GitHub did not accept the sign-in.");
  return data.token;
}

/**
 * Open GitHub's authorization page and resolve with the token once the
 * popup has stored it. When the browser blocks the popup, this tab
 * navigates instead and the promise never settles (the page comes back
 * through `completeGitHubLogin`).
 */
export function beginGitHubLogin(clientId: string): Promise<string> {
  const state = randomState();
  const url = authorizeUrl(clientId, state);
  const popup = window.open(url, "sparkbox-github", "popup,width=600,height=760");
  writePending({ state, popup: Boolean(popup), returnTo: location.hash, startedAt: Date.now() });
  if (!popup) {
    location.assign(url);
    return new Promise(() => {});
  }
  const before = settings.githubToken();
  return new Promise((resolve, reject) => {
    const finish = () => {
      window.removeEventListener("storage", onStorage);
      clearInterval(watch);
    };
    const arrived = () => {
      const token = settings.githubToken();
      if (!token || token === before) return false;
      finish();
      resolve(token);
      return true;
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.endsWith("github-token")) arrived();
    };
    window.addEventListener("storage", onStorage);
    const watch = setInterval(() => {
      if (arrived()) return;
      if (popup.closed) {
        finish();
        // The same token again counts as signed in, with nothing to change.
        if (settings.githubToken()) resolve(settings.githubToken());
        else reject(new Error("The GitHub sign-in window was closed."));
      }
    }, 400);
  });
}

export type CompletedLogin = { token: string; popup: boolean; returnTo: string };

/**
 * Finish a sign-in if the page was opened with GitHub's `?code=&state=`.
 * Returns the token, whether this page is the popup (which should then
 * close), and where the tab was before a same-tab redirect. Null when this
 * page load is not a GitHub callback.
 */
export async function completeGitHubLogin(): Promise<CompletedLogin | null> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state?.startsWith("gh-")) return null;
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  const pending = readPending();
  writePending(null);
  if (pending && !pending.popup) url.hash = pending.returnTo;
  history.replaceState(null, "", url.href);
  if (!pending || pending.state !== state)
    throw new Error("The GitHub sign-in did not match this browser. Try again.");
  const token = await exchangeCode(code);
  return { token, popup: pending.popup, returnTo: pending.returnTo };
}
