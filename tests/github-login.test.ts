import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The page side of Sign in with GitHub. The app is cross-origin isolated, so
 * the opener's handle on the popup reads `closed` as soon as the popup
 * reaches github.com; the outcome has to come back through localStorage.
 */
const store = new Map<string, string>();
const popup = { closed: true };

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  vi.stubGlobal("window", {
    open: () => popup,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("location", { hash: "", href: "https://sparkbox.test/", assign: () => {} });
  vi.stubGlobal("history", { replaceState: () => {} });
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("beginGitHubLogin", () => {
  it("keeps waiting while the severed popup reads as closed, then takes the token", async () => {
    const { beginGitHubLogin } = await import("../src/github/auth.ts");
    let settled = "";
    const login = beginGitHubLogin("client").then((token) => {
      settled = token;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe("");
    // What the popup leaves behind once it has verified the token.
    store.set("sparkbox:github-token", "gho_new");
    store.set("sparkbox:github-result", JSON.stringify({ ok: true, at: Date.now() }));
    await vi.advanceTimersByTimeAsync(600);
    await login;
    expect(settled).toBe("gho_new");
  });

  it("reports what went wrong in the popup", async () => {
    const { beginGitHubLogin } = await import("../src/github/auth.ts");
    const login = beginGitHubLogin("client");
    const outcome = login.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(100);
    store.set(
      "sparkbox:github-result",
      JSON.stringify({ error: "The code is wrong.", at: Date.now() }),
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(await outcome).toBe("The code is wrong.");
  });

  it("ignores an outcome left over from an earlier sign-in", async () => {
    store.set("sparkbox:github-result", JSON.stringify({ error: "old", at: Date.now() - 60_000 }));
    store.set("sparkbox:github-token", "gho_old");
    const { beginGitHubLogin } = await import("../src/github/auth.ts");
    let settled = false;
    void beginGitHubLogin("client").then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
  });

  it("a second click reopens the popup and shares the same wait", async () => {
    const { beginGitHubLogin } = await import("../src/github/auth.ts");
    const first = beginGitHubLogin("client");
    const second = beginGitHubLogin("client");
    expect(second).toBe(first);
  });
});

describe("completeGitHubLogin", () => {
  it("tells the opener when the popup's sign-in does not match", async () => {
    store.set(
      "sparkbox:github-state",
      JSON.stringify({ state: "gh-expected", popup: true, returnTo: "", startedAt: Date.now() }),
    );
    vi.stubGlobal("location", {
      hash: "",
      href: "https://sparkbox.test/?code=abc&state=gh-other",
      assign: () => {},
    });
    const { completeGitHubLogin } = await import("../src/github/auth.ts");
    await expect(completeGitHubLogin()).rejects.toThrow("did not match");
    const result = JSON.parse(store.get("sparkbox:github-result") ?? "null");
    expect(result.error).toMatch("did not match");
  });
});
