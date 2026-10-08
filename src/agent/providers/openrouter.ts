import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
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
  }
  export() {
    return this.messages;
  }
  import(state: unknown) {
    this.messages = Array.isArray(state) ? (state as ChatCompletionMessageParam[]) : [];
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
          },
          { signal: context.signal },
        );
        stream.on("content", (delta) => context.sink.text(textId, delta));
        const completion = await stream.finalChatCompletion();
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
