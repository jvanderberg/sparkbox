/**
 * Runtime configuration published by the host process at /config.json.
 * Absent (static hosting without the server), everything stays local-only.
 */
export type HostConfig = {
  previewOrigin: string;
  wispUrl: string;
  freeAgent: { label: string; model: string } | null;
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
        freeAgent:
          data.freeAgent && typeof data.freeAgent.model === "string"
            ? { label: String(data.freeAgent.label || "Sparkbox"), model: data.freeAgent.model }
            : null,
      };
    })
    .catch(() => ({ previewOrigin: "", wispUrl: "", freeAgent: null }));
  return loaded;
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
