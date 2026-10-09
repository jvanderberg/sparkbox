import { describe, expect, it } from "vitest";
import type { ProviderSession, TurnContext } from "../src/agent/providers/types.ts";
import { AgentRunner } from "../src/agent/runner.ts";
import type { AgentEvent } from "../src/agents/protocol.ts";
import { MemorySandbox } from "../src/sandbox/memory.ts";

/** A provider that edits a file through a tool and streams two text deltas. */
function fakeSession(behavior: "ok" | "hang" | "fail"): ProviderSession {
  return {
    provider: "anthropic",
    model: "fake",
    reset() {},
    export: () => [],
    import() {},
    promptTokens: () => 0,
    compact: async () => null,
    async run(prompt, context: TurnContext) {
      if (behavior === "fail") throw Object.assign(new Error("Unauthorized"), { status: 401 });
      context.sink.text("t1", `You said ${prompt.text}. `);
      context.sink.tool("tool1", "str_replace_based_edit_tool", {
        status: "running",
        input: { command: "create", path: "hello.txt" },
      });
      await context.sandbox.writeFile("hello.txt", "hi\n");
      context.sink.tool("tool1", "str_replace_based_edit_tool", {
        status: "done",
        input: { command: "create", path: "hello.txt" },
        output: "Created hello.txt",
      });
      if (behavior === "hang")
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      context.sink.text("t1", "Done.");
    },
  };
}

function collect(runner: AgentRunner) {
  const events: AgentEvent[] = [];
  runner.subscribe((event) => events.push(event));
  return events;
}

const waitFor = (events: AgentEvent[], type: string) =>
  new Promise<AgentEvent>((resolve) => {
    const check = () => {
      const found = events.find((event) => event.type === type);
      if (found) resolve(found);
      else setTimeout(check, 5);
    };
    check();
  });

describe("AgentRunner", () => {
  it("emits the Civic Spark event sequence for a turn", async () => {
    const sandbox = new MemorySandbox();
    const runner = new AgentRunner({
      workspace: "test",
      sandbox,
      networkEnabled: () => false,
      previewPort: 8080,
      createSession: () => fakeSession("ok"),
    });
    const events = collect(runner);
    runner.send({ type: "prompt", provider: "anthropic", text: "hello", id: crypto.randomUUID() });
    const done = await waitFor(events, "done");
    expect(done.outcome).toBe("success");
    expect(events.map((event) => event.type)).toEqual([
      "user",
      "status",
      "state",
      "text",
      "tool",
      "tool",
      "text",
      "status",
      "done",
      "state",
    ]);
    expect(await sandbox.readText("hello.txt")).toBe("hi\n");
    // The retained transcript appends text deltas with the same id.
    const text = runner.events.find((event) => event.type === "text");
    expect(text?.text).toBe("You said hello. Done.");
    const tool = runner.events.filter((event) => event.type === "tool");
    expect(tool).toHaveLength(1);
    expect(JSON.parse(tool[0]?.details ?? "{}").status).toBe("done");
  });

  it("queues a message during a turn, and Stop aborts and clears the queue", async () => {
    const runner = new AgentRunner({
      workspace: "test2",
      sandbox: new MemorySandbox(),
      networkEnabled: () => false,
      previewPort: 8080,
      createSession: () => fakeSession("hang"),
    });
    const events = collect(runner);
    runner.send({ type: "prompt", provider: "anthropic", text: "first", id: crypto.randomUUID() });
    await waitFor(events, "tool");
    runner.send({
      type: "prompt",
      provider: "anthropic",
      text: "second",
      id: crypto.randomUUID(),
      queue: true,
    });
    const queuedState = events.filter((event) => event.type === "state").at(-1);
    expect(queuedState?.queued?.map((message) => message.text)).toEqual(["second"]);
    runner.send({ type: "stop" });
    const done = await waitFor(events, "done");
    expect(done.outcome).toBe("stopped");
    expect(events.filter((event) => event.type === "user")).toHaveLength(1);
    expect(runner.working).toBe(false);
  });

  it("reports provider failures as error events", async () => {
    const runner = new AgentRunner({
      workspace: "test3",
      sandbox: new MemorySandbox(),
      networkEnabled: () => false,
      previewPort: 8080,
      createSession: () => fakeSession("fail"),
    });
    const events = collect(runner);
    runner.send({ type: "prompt", provider: "anthropic", text: "x", id: crypto.randomUUID() });
    const error = await waitFor(events, "error");
    expect(error.text).toMatch(/API key was rejected/);
    expect(error.credentialFailure).toBe(true);
    const done = await waitFor(events, "done");
    expect(done.outcome).toBe("failed");
  });
});
