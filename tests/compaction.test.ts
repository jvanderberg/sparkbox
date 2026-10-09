import { describe, expect, it } from "vitest";
import {
  compactionNotice,
  estimateTokens,
  excerpt,
  imageTokens,
  splitOldestTurns,
  summaryMessage,
} from "../src/agent/compaction.ts";
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
  });
});

/** A session that reports a chosen prompt size and records compaction calls. */
function sizedSession(tokens: { current: number }, compactions: number[]): ProviderSession {
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
    // 3000 -> 1500 before the turn, 1500 -> 750 after it; then it is under the limit.
    expect(compactions).toEqual([0.5, 0.5]);
    const notices = events.filter(
      (event) => event.type === "status" && /Compacted/.test(event.text),
    );
    expect(notices).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "status" && /^Compacting/.test(event.text)),
    ).toHaveLength(2);
    expect(notices[0]?.text).toContain("3,000 tokens");
    expect(notices[0]?.text).toContain("1,000-token limit");
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
