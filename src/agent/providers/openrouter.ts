import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  estimateTokens,
  excerpt,
  splitOldestTurns,
  summaryAcknowledgement,
  summaryInstructions,
  summaryMessage,
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
  interruptedToolOutput,
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
      defaultHeaders: { "HTTP-Referer": location.origin, "X-Title": "Sparkbox" },
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

  async compact(fraction: number, signal?: AbortSignal) {
    const split = splitOldestTurns(
      this.messages,
      (message) => message.role === "user" && !isSummary(message),
      fraction,
    );
    if (!split) return null;
    const transcript = split.folded.map(renderForSummary).filter(Boolean).join("\n\n");
    let summary: string;
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: summaryInstructions },
            { role: "user", content: transcript },
          ],
          max_tokens: 1500,
        },
        { signal },
      );
      summary = completion.choices[0]?.message.content ?? "";
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

  /** Tool messages for the calls a reload or stop left unanswered. */
  private unanswered(): ChatCompletionMessageParam[] {
    const index = this.messages.findLastIndex((message) => message.role === "assistant");
    const assistant = this.messages[index];
    if (assistant?.role !== "assistant" || !assistant.tool_calls?.length) return [];
    const answered = new Set(
      this.messages
        .slice(index + 1)
        .flatMap((message) => (message.role === "tool" ? [message.tool_call_id] : [])),
    );
    return assistant.tool_calls
      .filter((call) => !answered.has(call.id))
      .map((call) => ({ role: "tool", tool_call_id: call.id, content: interruptedToolOutput }));
  }

  async run(prompt: Prompt, context: TurnContext) {
    this.messages.push(...this.unanswered());
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
    context.checkpoint?.();
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
      context.checkpoint?.();
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
          context.checkpoint?.();
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
        context.checkpoint?.();
      }
    }
  }
}

function isSummary(message: ChatCompletionMessageParam) {
  return (
    typeof message.content === "string" && message.content.startsWith("[Earlier in this session")
  );
}

/** One message as text for the summarizer: images and long outputs trimmed. */
function renderForSummary(message: ChatCompletionMessageParam): string {
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
