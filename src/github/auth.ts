/**
 * Sign in with GitHub. The authorization happens on github.com in a popup
 * (so the sandbox keeps running) or, when popups are blocked, in this tab.
 * GitHub's token endpoint refuses browser requests and needs the app's
 * secret, so the code goes to the host, which swaps it for a token and keeps
 * nothing. Without a host the user pastes a token instead.
 */
const stateKey = "sparkbox:github-state";
const returnKey = "sparkbox:github-return";
export const scopes = "public_repo workflow";

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `gh-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function callbackUrl() {
  return `${location.origin}/`;
}

function authorizeUrl(clientId: string, state: string) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
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
 * Open GitHub's authorization page and resolve with a token. A popup is
 * tried first; when the browser blocks it, this tab navigates instead and
 * the promise never settles (the page comes back through
 * `completeGitHubLogin`).
 */
export function beginGitHubLogin(clientId: string): Promise<string> {
  const state = randomState();
  sessionStorage.setItem(stateKey, state);
  const url = authorizeUrl(clientId, state);
  const popup = window.open(url, "sparkbox-github", "popup,width=600,height=720");
  if (!popup) {
    sessionStorage.setItem(returnKey, location.hash);
    location.assign(url);
    return new Promise(() => {});
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(watch);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin) return;
      const data = event.data as { type?: string; code?: string; state?: string } | null;
      if (data?.type !== "sparkbox-github-code") return;
      finish();
      if (data.state !== state || !data.code) {
        reject(new Error("The GitHub sign-in did not match this page. Try again."));
        return;
      }
      sessionStorage.removeItem(stateKey);
      exchangeCode(data.code).then(resolve, reject);
    };
    window.addEventListener("message", onMessage);
    const watch = setInterval(() => {
      if (popup.closed) {
        finish();
        reject(new Error("The GitHub sign-in window was closed."));
      }
    }, 500);
  });
}

/**
 * Finish a sign-in if the page was opened with GitHub's `?code=&state=`.
 * In a popup the code is handed to the opener and the popup closes; after a
 * same-tab redirect the code is exchanged here. Returns the token, or null
 * when this page load is not a GitHub callback.
 */
export async function completeGitHubLogin(): Promise<string | null> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state?.startsWith("gh-")) return null;
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  if (window.opener && window.name === "sparkbox-github") {
    (window.opener as Window).postMessage(
      { type: "sparkbox-github-code", code, state },
      location.origin,
    );
    window.close();
    // A popup that cannot close shows the app; leave the code out of its URL.
    history.replaceState(null, "", url.href);
    return null;
  }
  const expected = sessionStorage.getItem(stateKey);
  const returnTo = sessionStorage.getItem(returnKey) ?? "";
  sessionStorage.removeItem(stateKey);
  sessionStorage.removeItem(returnKey);
  url.hash = returnTo;
  history.replaceState(null, "", url.href);
  if (expected !== state) throw new Error("The GitHub sign-in did not match this page. Try again.");
  return exchangeCode(code);
}
