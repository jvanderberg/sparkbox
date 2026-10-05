import { describe, expect, it } from "vitest";
import {
  agentFailure,
  agentInputSchema,
  agentModels,
  billingFailure,
  credentialFailure,
} from "../src/agents/protocol.ts";

describe("agent connection failures", () => {
  it("distinguishes credential failures from transient provider and runtime failures", () => {
    for (const status of [401, 403]) expect(credentialFailure({ status })).toBe(true);
    for (const status of [429, 500, 502, 503]) expect(credentialFailure({ status })).toBe(false);
    expect(credentialFailure({ message: "fetch failed" })).toBe(false);
    expect(credentialFailure({ message: "server exited" })).toBe(false);
    // A spent balance keeps the saved key: it is billing, not a rejected key.
    const billing = [
      { status: 402 },
      { status: 402, message: "Insufficient credits. Add more using https://openrouter.ai" },
      {
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing",
      },
      { data: { statusCode: 402, message: "Insufficient credits" } },
      { message: "Payment required for this request" },
    ];
    for (const error of billing) {
      expect(billingFailure(error)).toBe(true);
      expect(credentialFailure(error)).toBe(false);
      expect(agentFailure(error)).toBe(
        "This account has insufficient credits. Add credits to this account, then send again.",
      );
    }
    for (const error of [
      { status: 401 },
      { status: 403 },
      { status: 429 },
      { message: "fetch failed" },
      { message: "The API key is invalid", status: 401 },
    ])
      expect(billingFailure(error)).toBe(false);
    expect(agentInputSchema.parse({ type: "reconnect", provider: "opencode" })).toEqual({
      type: "reconnect",
      provider: "opencode",
    });
    expect(agentInputSchema.safeParse({ type: "reconnect", provider: "other" }).success).toBe(
      false,
    );
  });
  it("returns actionable messages without leaking provider payloads", () => {
    const secret = "private-test-credential";
    expect(agentFailure({ status: 401, message: secret })).toContain("API key was rejected");
    expect(agentFailure({ status: 402, message: secret })).toContain("insufficient credits");
    expect(agentFailure({ data: { statusCode: 429, message: secret } })).toContain("rate limiting");
    expect(agentFailure({ message: `Server exited: postinstall ${secret}` })).toContain(
      "installation checks",
    );
    expect(agentFailure({ message: secret })).not.toContain(secret);
    expect(agentFailure(null)).toContain("Retry");
  });
  it("allows only supported backends and uses fixed model presets", () => {
    expect(
      agentInputSchema.safeParse({ type: "prompt", provider: "arbitrary", text: "test" }).success,
    ).toBe(false);
    expect(
      agentInputSchema.parse({ type: "prompt", provider: "opencode", text: "test" }).type,
    ).toBe("prompt");
    expect(agentModels.opencode.model).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(agentModels.claude.model).toBe("claude-opus-5-5");
  });
});
