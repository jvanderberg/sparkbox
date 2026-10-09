import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicSession } from "../src/agent/providers/anthropic.ts";
import { OpenAISession } from "../src/agent/providers/openai.ts";
import { OpenRouterSession } from "../src/agent/providers/openrouter.ts";
import {
  interruptedToolOutput,
  type ProviderSession,
  type TurnContext,
} from "../src/agent/providers/types.ts";
import { AgentRunner } from "../src/agent/runner.ts";
import type { AgentEvent } from "../src/agents/protocol.ts";
import { MemorySandbox } from "../src/sandbox/memory.ts";

const stored = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/sandbox/storage.ts", () => ({
  kv: {
    get: async (store: string, key: string) =>
      structuredClone(stored.get(`${store}/${key}`) ?? null),
    set: async (store: string, key: string, value: unknown) => {
      stored.set(`${store}/${key}`, structuredClone(value));
    },
    delete: async (store: string, key: string) => {
      stored.delete(`${store}/${key}`);
    },
  },
}));

beforeEach(() => {
  stored.clear();
  const local = new Map<string, string>([["sparkbox:key:anthropic", "test-key"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  });
  vi.stubGlobal("location", { origin: "http://localhost" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A provider that records the prompt in its thread, then hangs until stopped and throws as the SDKs do. */
function threadSession(): ProviderSession & { messages: string[] } {
  return {
    provider: "anthropic",
    model: "fake",
    messages: [],
    reset() {
      this.messages = [];
    },
    export() {
      return this.messages;
    },
    import(state) {
      this.messages = state as string[];
    },
    promptTokens: () => 0,
    prune: () => ({ images: 0, results: 0 }),
    turns: () => 0,
    compact: async () => null,
    async run(prompt, context: TurnContext) {
      this.messages.push(prompt.text);
      context.checkpoint?.();
      context.sink.text("t1", "Working on it.");
      await new Promise<void>((_, reject) =>
        context.signal.addEventListener("abort", () => reject(new Error("Request was aborted.")), {
          once: true,
        }),
      );
    },
  };
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

const context = (): TurnContext => ({
  sandbox: new MemorySandbox(),
  signal: new AbortController().signal,
  system: "",
  sink: { text() {}, tool() {}, status() {} },
});

describe("the model's thread across a reload", () => {
  it("is saved while the turn runs and restored by the next runner", async () => {
    const options = {
      workspace: "reload",
      sandbox: new MemorySandbox(),
      networkEnabled: () => false,
      previewPort: 8080,
    };
    const first = threadSession();
    const runner = new AgentRunner({ ...options, createSession: () => first });
    const events: AgentEvent[] = [];
    runner.subscribe((event) => events.push(event));
    runner.send({ type: "prompt", provider: "anthropic", text: "build a transit dashboard" });
    await waitFor(events, "text");
    // The page reloads here: the turn never finishes.
    expect(stored.get("sessions/reload:anthropic")).toEqual(["build a transit dashboard"]);

    const second = threadSession();
    const reloaded = new AgentRunner({ ...options, createSession: () => second });
    await reloaded.attach(() => {});
    expect(second.messages).toEqual(["build a transit dashboard"]);
    runner.send({ type: "stop" });
  });

  it("keeps a stopped turn in the saved thread", async () => {
    const session = threadSession();
    const runner = new AgentRunner({
      workspace: "stopped",
      sandbox: new MemorySandbox(),
      networkEnabled: () => false,
      previewPort: 8080,
      createSession: () => session,
    });
    const events: AgentEvent[] = [];
    runner.subscribe((event) => events.push(event));
    runner.send({ type: "prompt", provider: "anthropic", text: "first" });
    await waitFor(events, "text");
    runner.send({ type: "stop" });
    await waitFor(events, "done");
    expect(stored.get("sessions/stopped:anthropic")).toEqual(["first"]);
  });
});

describe("a thread cut off mid-tool", () => {
  it("answers Claude's unfinished tool calls before the next prompt", async () => {
    const session = new AnthropicSession("key", "model");
    let sent: unknown[] = [];
    Object.assign(session, {
      client: {
        messages: {
          stream: (params: { messages: unknown[] }) => {
            sent = structuredClone(params.messages);
            return {
              on() {},
              finalMessage: async () => ({
                content: [{ type: "text", text: "ok" }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10 },
              }),
            };
          },
        },
      },
    });
    session.import([
      { role: "user", content: "build it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call1", name: "bash", input: { command: "ls" } }],
      },
    ]);
    await session.run({ text: "continue" }, context());
    expect(sent.slice(-2)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call1",
            content: interruptedToolOutput,
            is_error: true,
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  });

  it("answers OpenAI's unfinished calls before the next prompt", async () => {
    const session = new OpenAISession("key", "model");
    let sent: { type?: string; call_id?: string }[] = [];
    Object.assign(session, {
      client: {
        responses: {
          stream: (params: { input: typeof sent }) => {
            sent = structuredClone(params.input);
            return { on() {}, finalResponse: async () => ({ output: [], status: "completed" }) };
          },
        },
      },
    });
    session.import([
      { role: "user", content: [{ type: "input_text", text: "build it" }] },
      { type: "function_call", call_id: "done1", name: "preview", arguments: "{}" },
      { type: "function_call_output", call_id: "done1", output: "ok" },
      { type: "shell_call", call_id: "shell1", action: { commands: ["ls"] } },
    ]);
    await session.run({ text: "continue" }, context());
    const outputs = sent.filter((item) => item.type?.endsWith("_output"));
    expect(outputs.map((item) => item.call_id)).toEqual(["done1", "shell1"]);
    expect(sent.at(-2)).toMatchObject({ type: "shell_call_output", call_id: "shell1" });
  });

  it("answers OpenRouter's unfinished calls before the next prompt", async () => {
    const session = new OpenRouterSession("key", "model");
    let sent: { role: string; tool_call_id?: string; content?: unknown }[] = [];
    Object.assign(session, {
      client: {
        chat: {
          completions: {
            stream: (params: { messages: typeof sent }) => {
              sent = structuredClone(params.messages);
              return {
                on() {},
                finalChatCompletion: async () => ({
                  choices: [{ message: { role: "assistant", content: "ok" } }],
                }),
              };
            },
          },
        },
      },
    });
    const call = (id: string) => ({
      id,
      type: "function",
      function: { name: "bash", arguments: "{}" },
    });
    session.import([
      { role: "user", content: "build it" },
      { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "ok" },
    ]);
    await session.run({ text: "continue" }, context());
    expect(sent.slice(-2, -1)).toEqual([
      { role: "tool", tool_call_id: "b", content: interruptedToolOutput },
    ]);
  });
});
