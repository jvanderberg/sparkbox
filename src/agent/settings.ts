import type { GitHubLink } from "../github/sync.ts";
import { type ProviderId, providers } from "./providers/types.ts";

/**
 * Provider keys and preferences live only in this browser's localStorage.
 * They are never written into the sandbox, the project files or exports.
 */
const prefix = "sparkbox:";
/** Fired on window with the project id when a project's GitHub link changes. */
export const githubLinkEvent = "sparkbox-github-link";

function read(key: string) {
  try {
    return localStorage.getItem(prefix + key) ?? "";
  } catch {
    return "";
  }
}
function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(prefix + key, value);
    else localStorage.removeItem(prefix + key);
  } catch {
    // Private browsing or a full store: the value just does not persist.
  }
}

export const settings = {
  key(provider: ProviderId) {
    return read(`key:${provider}`);
  },
  setKey(provider: ProviderId, value: string) {
    write(`key:${provider}`, value.trim());
  },
  model(provider: ProviderId) {
    return read(`model:${provider}`) || providers[provider].defaultModel;
  },
  setModel(provider: ProviderId, value: string) {
    write(`model:${provider}`, value.trim());
  },
  provider(): ProviderId {
    const value = read("provider");
    return value in providers ? (value as ProviderId) : "sparkbox";
  },
  setProvider(value: ProviderId) {
    write("provider", value);
  },
  wispUrl() {
    return read("wisp");
  },
  setWispUrl(value: string) {
    write("wisp", value.trim());
  },
  previewOrigin() {
    return read("preview-origin");
  },
  setPreviewOrigin(value: string) {
    write("preview-origin", value.trim());
  },
  /** Project secrets: environment variables for commands and the preview, redacted from tool output. */
  secrets(project: string): Record<string, string> {
    try {
      const parsed = JSON.parse(read(`secrets:${project}`) || "{}") as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch {
      return {};
    }
  },
  setSecrets(project: string, value: Record<string, string>) {
    const entries = Object.entries(value).filter(([name, secret]) => name && secret);
    write(`secrets:${project}`, entries.length ? JSON.stringify(Object.fromEntries(entries)) : "");
  },
  /** The GitHub token from Sign in with GitHub or a pasted token. Goes only to api.github.com. */
  githubToken() {
    return read("github-token");
  },
  setGithubToken(value: string) {
    write("github-token", value.trim());
  },
  githubLogin() {
    return read("github-login");
  },
  setGithubLogin(value: string) {
    write("github-login", value.trim());
  },
  /** The repository a project is backed up to, if any. */
  githubLink(project: string): GitHubLink | null {
    try {
      const parsed = JSON.parse(read(`github:${project}`) || "null") as GitHubLink | null;
      if (!parsed || typeof parsed !== "object" || !parsed.owner || !parsed.name) return null;
      return { ...parsed, auto: parsed.auto !== false };
    } catch {
      return null;
    }
  },
  setGithubLink(project: string, value: GitHubLink | null) {
    write(`github:${project}`, value ? JSON.stringify(value) : "");
    // Settings and the workspace header both show the link; tell the other.
    window.dispatchEvent(new CustomEvent(githubLinkEvent, { detail: project }));
  },
  /** A repository to clone into a project the first time it opens. */
  pendingClone(project: string) {
    return read(`clone:${project}`);
  },
  setPendingClone(project: string, url: string | null) {
    write(`clone:${project}`, url ?? "");
  },
  configuredProviders(): ProviderId[] {
    return (Object.keys(providers) as ProviderId[]).filter((provider) =>
      Boolean(this.key(provider)),
    );
  },
};
