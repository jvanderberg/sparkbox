import { describe, expect, it } from "vitest";
import {
  compactionNotice,
  estimateTokens,
  excerpt,
  imagePlaceholder,
  imageTokens,
  splitOldestTurns,
  summaryInstructions,
  summaryMessage,
  summaryWords,
} from "../src/agent/compaction.ts";
import { OpenRouterSession } from "../src/agent/providers/openrouter.ts";
import type { Prompt, ProviderSession, TurnContext } from "../src/agent/providers/types.ts";
import { AgentRunner } from "../src/agent/runner.ts";
import type { AgentEvent } from "../src/agents/protocol.ts";
import { MemorySandbox } from "../src/sandbox/memory.ts";

type Msg = { role: "user" | "assistant" | "tool"; text: string };

describe("splitOldestTurns", () => {
  const isUser = (m: Msg) => m.role === "user";
  const turn = (n: number): Msg[] => [
    { role: "user", text: `u${n}` },
    { role: "assistant", text: `a${n}` },
    { role: "tool", text: `t${n}` },
    { role: "assistant", text: `b${n}` },
  ];
  it("folds the oldest half of the turns and keeps whole turns", () => {
    const messages = [...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5)];
    const split = splitOldestTurns(messages, isUser, 0.5);
    expect(split?.turns).toBe(2);
    expect(split?.folded.map((m) => m.text)).toEqual([
      "u1",
      "a1",
      "t1",
      "b1",
      "u2",
      "a2",
      "t2",
      "b2",
    ]);
    expect(split?.kept[0]?.text).toBe("u3");
    expect(split?.kept).toHaveLength(12);
  });
  it("always keeps at least one turn and needs at least two", () => {
    expect(splitOldestTurns([...turn(1)], isUser, 0.5)).toBeNull();
    const two = splitOldestTurns([...turn(1), ...turn(2)], isUser, 0.5);
    expect(two?.turns).toBe(1);
    expect(two?.kept[0]?.text).toBe("u2");
    const all = splitOldestTurns([...turn(1), ...turn(2), ...turn(3)], isUser, 1);
    expect(all?.turns).toBe(2);
  });
});

describe("helpers", () => {
  it("estimates tokens from text and images, trims excerpts and words the notice", () => {
    expect(estimateTokens("x".repeat(400), 2)).toBe(100 + 2 * imageTokens);
    const trimmed = excerpt("a".repeat(100) + "b".repeat(100), 50);
    expect(trimmed).toContain("characters omitted");
    expect(trimmed.length).toBeLessThan(120);
    expect(excerpt("short")).toBe("short");
    expect(summaryMessage("  Built a map.  ")).toContain("Built a map.");
    expect(compactionNotice({ turns: 3, promptTokens: 123456 }, 80000)).toContain("oldest 3 turns");
    expect(compactionNotice({ turns: 1, promptTokens: 90000 }, 80000)).toContain(
      "oldest 1 turn into",
    );
    expect(summaryWords(1000)).toBe(300);
    expect(summaryWords(40_000)).toBe(1000);
    expect(summaryWords(1_000_000)).toBe(1500);
    expect(summaryInstructions(450)).toContain("under 450 words");
  });
});

describe("pruning", () => {
  it("keeps the newest two images and shortens tool results before the current turn", () => {
    const session = new OpenRouterSession("key", "model");
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
    const long = "x".repeat(5000);
    session.import([
      { role: "user", content: [{ type: "text", text: "first" }, image] },
      { role: "assistant", content: "", tool_calls: [] },
      { role: "tool", tool_call_id: "1", content: long },
      { role: "user", content: [{ type: "text", text: "shot" }, image, image] },
      { role: "tool", tool_call_id: "2", content: long },
      { role: "user", content: [{ type: "text", text: "latest" }, image] },
      { role: "tool", tool_call_id: "3", content: long },
    ]);
    expect(session.prune()).toEqual({ images: 2, results: 2 });
    const messages = session.export() as { role: string; content: unknown }[];
    const content = (index: number) => {
      const message = messages[index];
      if (!message) throw new Error(`no message ${index}`);
      return message.content;
    };
    const types = (index: number) =>
      (content(index) as { type: string; text?: string }[]).map((p) =>
        p.type === "text" && p.text === imagePlaceholder ? "removed" : p.type,
      );
    expect(types(0)).toEqual(["text", "removed"]);
    expect(types(3)).toEqual(["text", "removed", "image_url"]);
    expect(types(5)).toEqual(["text", "image_url"]);
    expect((content(2) as string).length).toBeLessThan(2000);
    expect((content(6) as string).length).toBe(5000);
    // A second pass has nothing left to do.
    expect(session.prune()).toEqual({ images: 0, results: 0 });
  });
});

/** A session that reports a chosen prompt size and records compaction calls. */
function sizedSession(
  tokens: { current: number },
  compactions: number[],
  pruneSaves = 0,
): ProviderSession {
  return {
    provider: "anthropic",
    model: "fake",
    async run(_prompt: Prompt, context: TurnContext) {
      context.sink.text("t", "done");
    },
    reset() {},
    export: () => [],
    import() {},
    promptTokens: () => tokens.current,
    turns: () => 5,
    prune() {
      if (!pruneSaves) return { images: 0, results: 0 };
      tokens.current -= pruneSaves;
      return { images: 1, results: 2 };
    },
    async compact(fraction) {
      compactions.push(fraction);
      tokens.current = Math.floor(tokens.current / 2);
      return { turns: 2 };
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

describe("runner compaction", () => {
  it("compacts before and after a turn whose prompt is over the limit, and says so", async () => {
    const tokens = { current: 3000 };
    const compactions: number[] = [];
    const runner = new AgentRunner({
      workspace: "compaction-test",
      sandbox: new MemorySandbox(),
      networkEnabled: () => false,
      previewPort: 8080,
      contextLimit: () => 1000,
      createSession: () => sizedSession(tokens, compactions),
    });
    const events = collect(runner);
    runner.send({ type: "prompt", provider: "anthropic", text: "go", id: crypto.randomUUID() });
    await waitFor(events, "done");
    // 3000 -> 1500 -> 750 in two rounds before the turn; nothing left to do after it.
    expect(compactions).toEqual([0.5, 0.5]);
    const notices = events.filter(
      (event) => event.type === "status" && /Compacted/.test(event.text),
    );
    expect(notices).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "status" && /^Compacting/.test(event.text)),
    ).toHaveLength(1);
    expect(notices[0]?.text).toContain("3,000 tokens");
    expect(notices[0]?.text).toContain("1,000-token limit");
  });
  it("trims first, and folds repeatedly until under the limit", async () => {
    const trimmed = { current: 1200 };
    const trimmedCompactions: number[] = [];
    const runnerA = new AgentRunner({
      workspace: "compaction-trim",
      sandbox: new MemorySandbox(),
      networkEnabled: () => false,
      previewPort: 8080,
      contextLimit: () => 1000,
      createSession: () => sizedSession(trimmed, trimmedCompactions, 500),
    });
    const eventsA = collect(runnerA);
    runnerA.send({ type: "prompt", provider: "anthropic", text: "go", id: crypto.randomUUID() });
    await waitFor(eventsA, "done");
    expect(trimmedCompactions).toEqual([]);
    expect(
      eventsA.some(
        (e) =>
          e.type === "status" &&
          /^Trimmed 1 older screenshot and 2 older tool results/.test(e.text),
      ),
    ).toBe(true);
    const big = { current: 9000 };
    const bigCompactions: number[] = [];
    const runnerB = new AgentRunner({
      workspace: "compaction-rounds",
      sandbox: new MemorySandbox(),
      networkEnabled: () => false,
      previewPort: 8080,
      contextLimit: () => 1000,
      createSession: () => sizedSession(big, bigCompactions),
    });
    const eventsB = collect(runnerB);
    runnerB.send({ type: "prompt", provider: "anthropic", text: "go", id: crypto.randomUUID() });
    await waitFor(eventsB, "done");
    // 9000 -> 4500 -> 2250 -> 1125 (three rounds before), then 562 after.
    expect(bigCompactions).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
  it("leaves the conversation alone when the deployment sets no limit", async () => {
    const compactions: number[] = [];
    const runner = new AgentRunner({
      workspace: "compaction-off",
      sandbox: new MemorySandbox(),
      networkEnabled: () => false,
      previewPort: 8080,
      createSession: () => sizedSession({ current: 1_000_000 }, compactions),
    });
    const events = collect(runner);
    runner.send({ type: "prompt", provider: "anthropic", text: "go", id: crypto.randomUUID() });
    await waitFor(events, "done");
    expect(compactions).toEqual([]);
  });
});
