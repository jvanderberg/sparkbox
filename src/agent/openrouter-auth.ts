/**
 * OpenRouter OAuth PKCE. The user approves on openrouter.ai and comes back
 * with a one-time code that this page exchanges for a key they control.
 * No client registration, secret or server is involved.
 */
const verifierKey = "sparkbox:openrouter-verifier";

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function beginOpenRouterLogin() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  sessionStorage.setItem(verifierKey, verifier);
  const callback = new URL(location.href);
  callback.searchParams.delete("code");
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callback.href);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", "Sparkbox");
  location.assign(url.href);
}

/** Finish a login if the page was opened with `?code=`. Returns the key. */
export async function completeOpenRouterLogin(): Promise<string | null> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  if (!code) return null;
  const verifier = sessionStorage.getItem(verifierKey);
  url.searchParams.delete("code");
  history.replaceState(null, "", url.href);
  sessionStorage.removeItem(verifierKey);
  if (!verifier) return null;
  const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!response.ok) throw new Error("OpenRouter did not accept the sign-in code.");
  const data = (await response.json()) as { key?: string };
  if (!data.key) throw new Error("OpenRouter returned no key.");
  return data.key;
}
