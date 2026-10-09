import { afterEach, describe, expect, it, vi } from "vitest";
import { mintToken } from "../server/tokens.ts";

describe("invite", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the expiry the host signed into the token, and drops an expired one", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
    const { invite, inviteExpiry } = await import("../src/invite.ts");
    const fresh = mintToken("secret", 90);
    expect(inviteExpiry(fresh)).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect(inviteExpiry("not a token")).toBe(0);

    store.set("sparkbox:key:sparkbox", fresh);
    expect(invite.token()).toBe(fresh);
    expect(invite.expired()).toBe(false);

    store.set("sparkbox:key:sparkbox", mintToken("secret", -1));
    expect(invite.token()).toBe("");
    expect(invite.expired()).toBe(true);

    invite.forget();
    expect(store.has("sparkbox:key:sparkbox")).toBe(false);
    expect(invite.expired()).toBe(false);
  });
});
