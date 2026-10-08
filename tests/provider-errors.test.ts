import { describe, expect, it } from "vitest";
import { describeFailure, failureDetail } from "../src/agent/providers/types.ts";

describe("provider failure messages", () => {
  it("keeps the upstream status and explanation for server errors", () => {
    const error = Object.assign(
      new Error('502 {"error":{"message":"Provider returned error","code":502}}'),
      {
        status: 502,
        error: { message: "Provider returned error", code: 502 },
      },
    );
    const failure = describeFailure(error);
    expect(failure.status).toBe(502);
    expect(failure.message).toBe(
      "The provider returned a server error (502: Provider returned error). Retry in a moment.",
    );
  });
  it("says when a server error came with no body instead of echoing the SDK placeholder", () => {
    // Fly's proxy answers this way when the host drops the connection.
    const failure = describeFailure({ status: 502, message: "502 status code (no body)" });
    expect(failure.message).toBe(
      "The provider returned a server error (502, no details). Retry in a moment.",
    );
    expect(failureDetail({ message: "502 status code (no body)" })).toBe("");
  });
  it("unwraps a JSON body in the message and shortens long text", () => {
    expect(failureDetail({ message: '503 {"error":"Overloaded"}' })).toBe("Overloaded");
    expect(failureDetail({ message: "x".repeat(400) })).toHaveLength(200);
    expect(describeFailure({ status: 418, message: "teapot" }).message).toBe(
      "The provider request failed (418): teapot.",
    );
  });
  it("still maps credential and rate errors to their short messages", () => {
    expect(describeFailure({ status: 401, message: "nope" }).kind).toBe("credential");
    expect(describeFailure({ status: 429, message: "slow down" }).kind).toBe("rate");
  });
});
