import { describe, expect, it } from "vitest";
import { deadline, RuntimeHung } from "../src/sandbox/deadline.ts";

describe("deadline", () => {
  it("passes a settled value through", async () => {
    expect(await deadline(Promise.resolve(7), 50, "finish")).toBe(7);
    await expect(deadline(Promise.reject(new Error("boom")), 50, "finish")).rejects.toThrow("boom");
  });
  it("reports a hang as RuntimeHung with the deadline in the message", async () => {
    const never = new Promise<never>(() => {});
    const error = await deadline(never, 20, "start a process").catch((e: Error) => e);
    expect(error).toBeInstanceOf(RuntimeHung);
    expect(error.message).toMatch(/did not start a process within 0s/);
  });
});
