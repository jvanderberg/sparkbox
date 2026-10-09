import Anthropic from "@anthropic-ai/sdk";
import {
  estimateTokens,
  excerpt,
  splitOldestTurns,
  summaryAcknowledgement,
  summaryInstructions,
  summaryMessage,
} from "../compaction.ts";
import { pageTools, runPageTool, runShell, textEditor } from "../tools.ts";
import {
  describeFailure,
  interruptedToolOutput,
  type Prompt,
  type ProviderSession,
  type TurnContext,
} from "./types.ts";

const tools: Anthropic.Messages.ToolUnion[] = [
  { type: "bash_20250124", name: "bash" },
  { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
  ...pageTools.map(
    (tool): Anthropic.Messages.Tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as unknown as Anthropic.Messages.Tool.InputSchema,
    }),
  ),
];

/** Claude through the Messages API with the Anthropic-defined coding tools. */
export class AnthropicSession implements ProviderSession {
  readonly provider = "anthropic" as const;
  private client: Anthropic;
  private messages: Anthropic.Messages.MessageParam[] = [];
  private lastPromptTokens: number | null = null;
  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  }

  reset() {
    this.messages = [];
    this.lastPromptTokens = null;
  }
  export() {
    return this.messages;
  }
  import(state: unknown) {
    this.messages = Array.isArray(state) ? (state as Anthropic.Messages.MessageParam[]) : [];
    this.lastPromptTokens = null;
  }

  promptTokens() {
    if (this.lastPromptTokens !== null) return this.lastPromptTokens;
    let images = 0;
    const text = JSON.stringify(this.messages, (key, value: unknown) => {
      if (key === "source" && value && typeof value === "object" && "data" in value) {
        images++;
        return undefined;
      }
      return value;
    });
    return estimateTokens(text, images);
  }

  async compact(fraction: number, signal?: AbortSignal) {
    const split = splitOldestTurns(this.messages, isUserPrompt, fraction);
    if (!split) return null;
    const transcript = split.folded.map(renderForSummary).filter(Boolean).join("\n\n");
    let summary = "";
    try {
      const message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 1500,
          system: summaryInstructions,
          messages: [{ role: "user", content: transcript }],
        },
        { signal },
      );
      for (const block of message.content) if (block.type === "text") summary += block.text;
    } catch (error) {
      throw describeFailure(error);
    }
    if (!summary.trim()) throw new Error("The model returned an empty summary.");
    this.messages = [
      { role: "user", content: [{ type: "text", text: summaryMessage(summary) }] },
      { role: "assistant", content: [{ type: "text", text: summaryAcknowledgement }] },
      ...split.kept,
    ];
    this.lastPromptTokens = null;
    return { turns: split.turns };
  }

  /** Results for the tool calls a reload or stop left unanswered at the end of the thread. */
  private unanswered(): Anthropic.Messages.ToolResultBlockParam[] {
    const last = this.messages.at(-1);
    if (last?.role !== "assistant" || typeof last.content === "string") return [];
    return last.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: interruptedToolOutput,
        is_error: true,
      }));
  }

  async run(prompt: Prompt, context: TurnContext) {
    // Its own message, so compaction still sees the prompt below as a turn.
    const interrupted = this.unanswered();
    if (interrupted.length) this.messages.push({ role: "user", content: interrupted });
    const content: Anthropic.Messages.ContentBlockParam[] = [
      ...(prompt.images ?? []).map(
        (image): Anthropic.Messages.ImageBlockParam => ({
          type: "image",
          source: { type: "base64", media_type: image.mime, data: image.data },
        }),
      ),
      { type: "text", text: prompt.text || "(see attached images)" },
    ];
    this.messages.push({ role: "user", content });
    context.checkpoint?.();
    for (let step = 0; step < 200; step++) {
      if (context.signal.aborted) return;
      const textId = crypto.randomUUID();
      let message: Anthropic.Messages.Message;
      try {
        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: 32_000,
            system: [{ type: "text", text: context.system, cache_control: { type: "ephemeral" } }],
            messages: this.messages,
            tools,
          },
          { signal: context.signal },
        );
        stream.on("text", (delta) => context.sink.text(textId, delta));
        message = await stream.finalMessage();
        this.lastPromptTokens =
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0);
      } catch (error) {
        // A failed request leaves the user turn in history so a retry resends it.
        throw describeFailure(error);
      }
      this.messages.push({ role: "assistant", content: message.content });
      context.checkpoint?.();
      if (message.stop_reason === "refusal") {
        context.sink.status("The model declined this request.");
        return;
      }
      if (message.stop_reason === "max_tokens") {
        context.sink.status("The response hit the output limit.");
        return;
      }
      const uses = message.content.filter(
        (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
      );
      if (!uses.length) return;
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        context.sink.tool(use.id, use.name, { status: "running", input });
        let output = "";
        let failed = false;
        let image: { data: string; mime: "image/jpeg" | "image/png" } | undefined;
        try {
          const page = await runPageTool(use.name, input, {
            sandbox: context.sandbox,
            preview: context.preview,
            github: context.github,
            signal: context.signal,
            fetchProxy: context.fetchProxy,
            secrets: context.secrets,
          });
          if (page) {
            output = page.output;
            failed = Boolean(page.error);
            image = page.image;
          } else if (use.name === "bash") {
            if (input.restart) output = "Shell restarted.";
            else {
              let live = "";
              const result = await runShell(context.sandbox, String(input.command ?? ""), {
                signal: context.signal,
                onOutput: (chunk) => {
                  live += chunk;
                  context.sink.tool(use.id, use.name, {
                    status: "running",
                    input,
                    output: live.slice(-4000),
                  });
                },
              });
              output = result.output || "(no output)";
              failed = result.exitCode !== 0;
            }
          } else {
            const result = await textEditor(context.sandbox, input);
            output = result.output;
            failed = Boolean(result.error);
          }
        } catch (error) {
          output = error instanceof Error ? error.message : String(error);
          failed = true;
        }
        context.sink.tool(use.id, use.name, {
          status: failed ? "error" : "done",
          input,
          output,
        });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: image
            ? [
                { type: "text", text: output },
                {
                  type: "image",
                  source: { type: "base64", media_type: image.mime, data: image.data },
                },
              ]
            : output,
          ...(failed ? { is_error: true } : {}),
        });
      }
      this.messages.push({ role: "user", content: results });
      context.checkpoint?.();
    }
  }
}

/** A real user prompt (text or images), not a tool-result message or a compaction summary. */
function isUserPrompt(message: Anthropic.Messages.MessageParam) {
  if (message.role !== "user") return false;
  if (typeof message.content === "string")
    return !message.content.startsWith("[Earlier in this session");
  if (message.content.some((block) => block.type === "tool_result")) return false;
  const first = message.content[0];
  return !(first?.type === "text" && first.text.startsWith("[Earlier in this session"));
}

/** One message as text for the summarizer: images and long outputs trimmed. */
function renderForSummary(message: Anthropic.Messages.MessageParam): string {
  const blocks: Anthropic.Messages.ContentBlockParam[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push("[image]");
    else if (block.type === "tool_use")
      parts.push(`[tool ${block.name}(${excerpt(JSON.stringify(block.input), 400)})]`);
    else if (block.type === "tool_result") {
      const text =
        typeof block.content === "string"
          ? block.content
          : (block.content ?? [])
              .map((part) => (part.type === "text" ? part.text : "[image]"))
              .join("\n");
      parts.push(`Tool result: ${excerpt(text, 1200)}`);
    }
  }
  if (!parts.length) return "";
  return `${message.role === "user" ? "User" : "Agent"}: ${excerpt(parts.join("\n"), 3000)}`;
}
