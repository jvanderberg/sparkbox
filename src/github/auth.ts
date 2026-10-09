/**
 * Sign in with GitHub. The authorization happens on github.com in a popup
 * (so the sandbox keeps running) or, when popups are blocked, in this tab.
 * GitHub's token endpoint refuses browser requests and needs the app's
 * secret, so the code goes to the host, which swaps it for a token and keeps
 * nothing. Without a host the user pastes a token instead.
 *
 * The app is cross-origin isolated, which severs a popup from its opener as
 * soon as it visits github.com, so the popup cannot post the code back.
 * Instead the popup completes the sign-in itself, stores the token and
 * records how it went; the opening tab sees that arrive through localStorage.
 */
import { settings } from "../agent/settings.ts";
import { githubAccount } from "./account.ts";

const stateKey = "sparkbox:github-state";
/** How the popup's sign-in ended, for the tab that opened it. */
const resultKey = "sparkbox:github-result";
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

type LoginResult = { ok: true; at: number } | { error: string; at: number };

function readResult(): LoginResult | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(resultKey) || "null") as LoginResult | null;
    return parsed && typeof parsed.at === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeResult(result: LoginResult) {
  try {
    localStorage.setItem(resultKey, JSON.stringify(result));
  } catch {
    // The opening tab still sees the token arrive when it next reads it.
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
 * popup reports that it stored one. When the browser blocks the popup, this
 * tab navigates instead and the promise never settles (the page comes back
 * through `completeGitHubLogin`).
 *
 * Cross-origin isolation also means `popup.closed` reads true as soon as the
 * popup reaches github.com, so a closed window cannot be told apart from a
 * sign-in still in progress. The wait ends when the popup reports, or after
 * ten minutes; clicking again reopens the popup and keeps the same wait.
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
  waiting ??= awaitResult().finally(() => {
    waiting = null;
  });
  return waiting;
}

let waiting: Promise<string> | null = null;

function awaitResult(): Promise<string> {
  const since = Date.now();
  return new Promise((resolve, reject) => {
    const finish = () => {
      window.removeEventListener("storage", onStorage);
      clearInterval(watch);
    };
    const check = () => {
      const result = readResult();
      if (!result || result.at < since) {
        if (Date.now() - since > 10 * 60_000) {
          finish();
          reject(new Error("GitHub did not finish the sign-in. Try again."));
        }
        return;
      }
      finish();
      const token = settings.githubToken();
      if ("error" in result) reject(new Error(result.error));
      else if (token) resolve(token);
      else reject(new Error("GitHub did not finish the sign-in. Try again."));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === resultKey) check();
    };
    window.addEventListener("storage", onStorage);
    // Storage events are the fast path; the poll covers a missed one.
    const watch = setInterval(check, 500);
  });
}

export type CompletedLogin = { login: string; popup: boolean; returnTo: string };

/**
 * Finish a sign-in if the page was opened with GitHub's `?code=&state=`:
 * swap the code for a token, verify it and keep it. Returns the login,
 * whether this page is the popup (which should then close), and where the
 * tab was before a same-tab redirect. Null when this page load is not a
 * GitHub callback. A popup reports how it went to the tab that opened it.
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
  // Without the pending record this may still be the popup; reporting is harmless.
  const report = pending?.popup !== false;
  try {
    if (!pending || pending.state !== state)
      throw new Error("The GitHub sign-in did not match this browser. Try again.");
    const login = await githubAccount.connect(await exchangeCode(code));
    if (report) writeResult({ ok: true, at: Date.now() });
    return { login, popup: pending.popup, returnTo: pending.returnTo };
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub did not accept the sign-in.";
    if (report) writeResult({ error: message, at: Date.now() });
    throw error;
  }
}
