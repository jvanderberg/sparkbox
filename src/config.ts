/**
 * Runtime configuration published by the host process at /config.json.
 * Absent (static hosting without the server), everything stays local-only.
 */
export type HostConfig = {
  previewOrigin: string;
  wispUrl: string;
  /** The host's fetch proxy for the download tool; empty without a host. */
  fetchUrl: string;
  freeAgent: { label: string; model: string } | null;
  /** The OAuth app for "Sign in with GitHub"; empty without a host that has one. */
  githubClientId: string;
  /** The host's relay for git pushes and pulls; empty without a host. */
  gitProxyUrl: string;
  /** Prompt tokens past which the runner folds the oldest half of a conversation; 0 is off. */
  contextLimit: number;
};

let loaded: Promise<HostConfig> | null = null;

export function hostConfig(): Promise<HostConfig> {
  loaded ??= fetch("/config.json", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as Partial<HostConfig>;
      return {
        previewOrigin: typeof data.previewOrigin === "string" ? data.previewOrigin : "",
        wispUrl: typeof data.wispUrl === "string" ? data.wispUrl : "",
        fetchUrl: typeof data.fetchUrl === "string" ? data.fetchUrl : "",
        freeAgent:
          data.freeAgent && typeof data.freeAgent.model === "string"
            ? { label: String(data.freeAgent.label || "Sparkbox"), model: data.freeAgent.model }
            : null,
        githubClientId: typeof data.githubClientId === "string" ? data.githubClientId : "",
        gitProxyUrl: typeof data.gitProxyUrl === "string" ? data.gitProxyUrl : "",
        contextLimit:
          typeof data.contextLimit === "number" && data.contextLimit > 0
            ? Math.floor(data.contextLimit)
            : 0,
      };
    })
    .catch(() => ({
      previewOrigin: "",
      wispUrl: "",
      fetchUrl: "",
      freeAgent: null,
      githubClientId: "",
      gitProxyUrl: "",
      contextLimit: 0,
    }));
  return loaded;
}

/**
 * A short-lived relay URL for the sandbox, minted for this invite token. The
 * invite itself never appears in the connection URL.
 */
export async function relayUrl(token: string): Promise<string> {
  const response = await fetch("/api/relay", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !data.url) throw new Error(data.error ?? "The relay refused this invite.");
  return data.url;
}

/** Exchange an invite code for a session token. */
export async function redeemInvite(code: string): Promise<string> {
  const response = await fetch("/api/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !data.token)
    throw new Error(data.error ?? "The invite code was not accepted.");
  return data.token;
}
