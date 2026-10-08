import { describe, expect, it } from "vitest";
import { exchangeGitHubCode } from "../server/github-auth.ts";

const app = { clientId: "id", clientSecret: "secret" };

describe("exchangeGitHubCode", () => {
  it("sends the code with the app's credentials and returns the token", async () => {
    let sent: { url: string; body: unknown } | null = null;
    const result = await exchangeGitHubCode({ ...app, code: "abc123" }, async (url, init) => {
      sent = { url, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ access_token: "gho_x", token_type: "bearer" }), {
        status: 200,
      });
    });
    expect(result).toEqual({ token: "gho_x" });
    expect(sent).toEqual({
      url: "https://github.com/login/oauth/access_token",
      body: { client_id: "id", client_secret: "secret", code: "abc123" },
    });
  });
  it("passes GitHub's explanation through and refuses malformed codes without a request", async () => {
    const refused = await exchangeGitHubCode({ ...app, code: "abc" }, async () => {
      return new Response(
        JSON.stringify({ error: "bad_verification_code", error_description: "The code is wrong." }),
        { status: 200 },
      );
    });
    expect(refused).toEqual({ error: "The code is wrong." });
    let requests = 0;
    const malformed = await exchangeGitHubCode({ ...app, code: "a b" }, async () => {
      requests++;
      return new Response("{}");
    });
    expect("error" in malformed).toBe(true);
    expect(requests).toBe(0);
  });
});
