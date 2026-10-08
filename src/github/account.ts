/**
 * The signed-in GitHub account, shared by the projects home, the workspace
 * header and Settings. The token lives in localStorage with the provider
 * keys and is sent only to api.github.com.
 */
import { useSyncExternalStore } from "react";
import { settings } from "../agent/settings.ts";
import { GitHubClient, GitHubError } from "./api.ts";

export type GitHubAccount = { token: string; login: string } | null;

const listeners = new Set<() => void>();
let current: GitHubAccount = read();

function read(): GitHubAccount {
  const token = settings.githubToken();
  return token ? { token, login: settings.githubLogin() } : null;
}

function notify() {
  current = read();
  for (const listener of listeners) listener();
}

// A sign-in completed in the popup, or a sign-out in another tab, shows up here.
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith("sparkbox:github-")) notify();
  });

export const githubAccount = {
  get(): GitHubAccount {
    return current;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Verify a token against GitHub, then keep it. Returns the login. */
  async connect(token: string): Promise<string> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Paste a token first.");
    let login: string;
    try {
      login = (await new GitHubClient(trimmed).user()).login;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401)
        throw new Error("GitHub does not accept that token.");
      throw error;
    }
    settings.setGithubToken(trimmed);
    settings.setGithubLogin(login);
    notify();
    return login;
  },
  disconnect() {
    settings.setGithubToken("");
    settings.setGithubLogin("");
    notify();
  },
  client(): GitHubClient | null {
    return current ? new GitHubClient(current.token) : null;
  },
};

/** Clear a sign-in GitHub no longer accepts, so the next click asks again. */
export function forgetIfExpired(error: unknown) {
  if (error instanceof GitHubError && error.status === 401) githubAccount.disconnect();
}

export function useGitHubAccount(): GitHubAccount {
  return useSyncExternalStore(githubAccount.subscribe, githubAccount.get);
}
