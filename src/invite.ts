/**
 * The invite this browser redeemed. The host swaps the code for a signed
 * token (`<id>.<expires>.<signature>`), kept as the Sparkbox provider's key.
 * It pays for more than the free agent: the sandbox's network relay and the
 * download tool's fetch proxy need it too, so a host that hands out invites
 * asks for one before anything else.
 */
import { useSyncExternalStore } from "react";
import { settings } from "./agent/settings.ts";
import { redeemInvite } from "./config.ts";

const listeners = new Set<() => void>();

/** When a token stops working, from the expiry it carries; 0 when it is not one. */
export function inviteExpiry(token: string) {
  const expires = Number(token.split(".")[1]);
  return Number.isFinite(expires) ? expires : 0;
}

function current() {
  const token = settings.key("sparkbox");
  return token && inviteExpiry(token) > Date.now() ? token : "";
}

function changed() {
  for (const listener of listeners) listener();
}

// Redeemed or forgotten in another tab.
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "sparkbox:key:sparkbox") changed();
  });

export const invite = {
  /** The token, or empty when there is none or it has expired. */
  token: current,
  /** True when a token is stored but past its expiry. */
  expired() {
    return Boolean(settings.key("sparkbox")) && !current();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async redeem(code: string) {
    settings.setKey("sparkbox", await redeemInvite(code.trim()));
    changed();
  },
  forget() {
    settings.setKey("sparkbox", "");
    changed();
  },
};

export function useInvite(): string {
  return useSyncExternalStore(invite.subscribe, invite.token);
}
