import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  estimateTokens,
  excerpt,
  imagePlaceholder,
  keepImages,
  pruneNotice,
  splitOldestTurns,
  summaryAcknowledgement,
  summaryInstructions,
  summaryMessage,
  summaryWords,
  trimmedResultLimit,
} from "../compaction.ts";
import {
  genericTools,
  pageTools,
  runGenericTool,
  runPageTool,
  type ToolOutcome,
} from "../tools.ts";
import {
  describeFailure,
  type Prompt,
  type ProviderId,
  type ProviderSession,
  type TurnContext,
} from "./types.ts";

const tools: ChatCompletionTool[] = [...genericTools, ...pageTools].map((tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
}));

/** Any OpenRouter model through its OpenAI-compatible chat API with function tools. */
export class OpenRouterSession implements ProviderSession {
  readonly provider: ProviderId;
  private client: OpenAI;
  private messages: ChatCompletionMessageParam[] = [];
  private lastPromptTokens: number | null = null;
  /**
   * `baseURL` defaults to OpenRouter. The Sparkbox free agent points it at
   * the host's proxy, which holds the real key and fixes the model.
   */
  constructor(
    apiKey: string,
    readonly model: string,
    options: { baseURL?: string; provider?: ProviderId } = {},
  ) {
    this.provider = options.provider ?? "openrouter";
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL ?? "https://openrouter.ai/api/v1",
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
      defaultHeaders: {
        "HTTP-Referer": typeof location === "undefined" ? "http://localhost" : location.origin,
        "X-Title": "Sparkbox",
      },
    });
  }

  reset() {
    this.messages = [];
    this.lastPromptTokens = null;
  }
  export() {
    return this.messages;
  }
  import(state: unknown) {
    this.messages = Array.isArray(state) ? (state as ChatCompletionMessageParam[]) : [];
    this.lastPromptTokens = null;
  }

  promptTokens() {
    if (this.lastPromptTokens !== null) return this.lastPromptTokens;
    let images = 0;
    const text = JSON.stringify(this.messages, (key, value: unknown) => {
      if (key === "image_url" && value && typeof value === "object") {
        images++;
        return undefined;
      }
      return value;
    });
    return estimateTokens(text, images);
  }

  prune() {
    const pruned = { images: 0, results: 0 };
    // Images: keep the newest few, counted from the end.
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (!message || typeof message.content === "string" || !Array.isArray(message.content))
        continue;
      if (message.role !== "user" && message.role !== "tool") continue;
      const parts = message.content as { type: string; text?: string }[];
      for (let j = parts.length - 1; j >= 0; j--) {
        if (parts[j]?.type !== "image_url") continue;
        if (seen++ < keepImages) continue;
        parts[j] = { type: "text", text: imagePlaceholder };
        pruned.images++;
      }
    }
    // Tool results before the current turn shrink to an excerpt.
    const lastUser = this.messages.findLastIndex(isUserPrompt);
    for (let i = 0; i < lastUser; i++) {
      const message = this.messages[i];
      if (message?.role !== "tool" || typeof message.content !== "string") continue;
      if (message.content.length <= trimmedResultLimit) continue;
      message.content = excerpt(message.content, trimmedResultLimit);
      pruned.results++;
    }
    if (pruned.images || pruned.results) this.lastPromptTokens = null;
    return pruned;
  }

  turns() {
    return this.messages.filter(isUserPrompt).length;
  }

  async compact(fraction: number, signal?: AbortSignal) {
    const split = splitOldestTurns(this.messages, isUserPrompt, fraction);
    if (!split) return null;
    const transcript = split.folded.map(renderForSummary).filter(Boolean).join("\n\n");
    const words = summaryWords(estimateTokens(JSON.stringify(split.folded), 0));
    let summary: string;
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: summaryInstructions(words) },
            { role: "user", content: transcript },
          ],
          // Room for the words plus slack; reasoning is off because a model
          // that thinks first can spend the whole budget before writing.
          max_tokens: Math.ceil(words * 3) + 500,
          ...({ reasoning: { enabled: false } } as object),
        },
        { signal },
      );
      summary = completion.choices[0]?.message.content ?? "";
      if (!summary.trim() && completion.choices[0]?.finish_reason === "length")
        throw new Error("The model ran out of output tokens before writing the summary.");
    } catch (error) {
      throw describeFailure(error);
    }
    if (!summary.trim()) throw new Error("The model returned an empty summary.");
    this.messages = [
      { role: "user", content: summaryMessage(summary) },
      { role: "assistant", content: summaryAcknowledgement },
      ...split.kept,
    ];
    this.lastPromptTokens = null;
    return { turns: split.turns };
  }

  /** Mid-turn: a long tool loop can outgrow the limit before the turn ends. */
  private trimIfOver(context: TurnContext) {
    if (!context.contextLimit || (this.lastPromptTokens ?? 0) <= context.contextLimit) return;
    const pruned = this.prune();
    if (pruned.images || pruned.results) context.sink.status(pruneNotice(pruned));
  }

  async run(prompt: Prompt, context: TurnContext) {
    this.messages.push({
      role: "user",
      content: [
        ...(prompt.images ?? []).map((image) => ({
          type: "image_url" as const,
          image_url: { url: `data:${image.mime};base64,${image.data}` },
        })),
        { type: "text" as const, text: prompt.text || "(see attached images)" },
      ],
    });
    for (let step = 0; step < 200; step++) {
      if (context.signal.aborted) return;
      const textId = crypto.randomUUID();
      let assistant: OpenAI.Chat.Completions.ChatCompletionMessage;
      try {
        const stream = this.client.chat.completions.stream(
          {
            model: this.model,
            messages: [{ role: "system", content: context.system }, ...this.messages],
            tools,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: context.signal },
        );
        stream.on("content", (delta) => context.sink.text(textId, delta));
        const completion = await stream.finalChatCompletion();
        if (completion.usage?.prompt_tokens) this.lastPromptTokens = completion.usage.prompt_tokens;
        this.trimIfOver(context);
        const choice = completion.choices[0];
        if (!choice) throw new Error("The provider returned no choices.");
        assistant = choice.message;
      } catch (error) {
        throw describeFailure(error);
      }
      this.messages.push({
        role: "assistant",
        content: assistant.content ?? "",
        ...(assistant.tool_calls?.length ? { tool_calls: assistant.tool_calls } : {}),
      });
      const calls = assistant.tool_calls ?? [];
      if (!calls.length) return;
      for (const call of calls) {
        if (call.type !== "function") continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "Invalid JSON arguments.",
          });
          continue;
        }
        context.sink.tool(call.id, call.function.name, { status: "running", input: args });
        let live = "";
        const page = await runPageTool(call.function.name, args, {
          sandbox: context.sandbox,
          preview: context.preview,
          github: context.github,
          signal: context.signal,
          fetchProxy: context.fetchProxy,
          secrets: context.secrets,
        }).catch(
          (error): ToolOutcome => ({
            output: error instanceof Error ? error.message : String(error),
            error: true,
          }),
        );
        if (page) {
          context.sink.tool(call.id, call.function.name, {
            status: page.error ? "error" : "done",
            input: args,
            output: page.output,
          });
          this.messages.push({ role: "tool", tool_call_id: call.id, content: page.output });
          // Chat tool messages are text only; the screenshot follows as a user turn.
          if (page.image)
            this.messages.push({
              role: "user",
              content: [
                { type: "text", text: `Screenshot from the preview tool (call ${call.id}):` },
                {
                  type: "image_url",
                  image_url: { url: `data:${page.image.mime};base64,${page.image.data}` },
                },
              ],
            });
          continue;
        }
        const result = await runGenericTool(context.sandbox, call.function.name, args, {
          signal: context.signal,
          onOutput: (chunk) => {
            live += chunk;
            context.sink.tool(call.id, call.function.name, {
              status: "running",
              input: args,
              output: live.slice(-4000),
            });
          },
        }).catch((error) => ({
          output: error instanceof Error ? error.message : String(error),
          error: true,
        }));
        context.sink.tool(call.id, call.function.name, {
          status: result.error ? "error" : "done",
          input: args,
          output: result.output,
        });
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
      }
    }
  }
}

function isSummary(message: ChatCompletionMessageParam) {
  return (
    typeof message.content === "string" && message.content.startsWith("[Earlier in this session")
  );
}

/** A screenshot handed to the model as a user message, which is part of the agent's turn. */
function isScreenshotFollowUp(message: ChatCompletionMessageParam) {
  if (message.role !== "user" || typeof message.content === "string") return false;
  const first = message.content?.[0];
  return first?.type === "text" && first.text.startsWith("Screenshot from the preview tool");
}

/** A real prompt from the user: where a turn starts. */
function isUserPrompt(message: ChatCompletionMessageParam) {
  return message.role === "user" && !isSummary(message) && !isScreenshotFollowUp(message);
}

/** One message as text for the summarizer: images and long outputs trimmed. */
function renderForSummary(message: ChatCompletionMessageParam): string {
  if (isScreenshotFollowUp(message)) return "Tool result: [screenshot]";
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .map((part) => (part.type === "text" ? part.text : "[image]"))
            .join("\n");
    return `User: ${excerpt(text, 3000)}`;
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    if (typeof message.content === "string" && message.content) parts.push(message.content);
    for (const call of message.tool_calls ?? [])
      if (call.type === "function")
        parts.push(`[tool ${call.function.name}(${excerpt(call.function.arguments, 400)})]`);
    return parts.length ? `Agent: ${excerpt(parts.join("\n"), 3000)}` : "";
  }
  if (message.role === "tool") {
    const text =
      typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return `Tool result: ${excerpt(text, 1200)}`;
  }
  return "";
}
