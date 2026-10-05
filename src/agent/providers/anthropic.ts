import Anthropic from "@anthropic-ai/sdk";
import { runShell, textEditor } from "../tools.ts";
import { describeFailure, type Prompt, type ProviderSession, type TurnContext } from "./types.ts";

const tools: Anthropic.Messages.ToolUnion[] = [
  { type: "bash_20250124", name: "bash" },
  { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
];

/** Claude through the Messages API with the Anthropic-defined coding tools. */
export class AnthropicSession implements ProviderSession {
  readonly provider = "anthropic" as const;
  private client: Anthropic;
  private messages: Anthropic.Messages.MessageParam[] = [];
  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  }

  reset() {
    this.messages = [];
  }
  export() {
    return this.messages;
  }
  import(state: unknown) {
    this.messages = Array.isArray(state) ? (state as Anthropic.Messages.MessageParam[]) : [];
  }

  async run(prompt: Prompt, context: TurnContext) {
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
      } catch (error) {
        // A failed request leaves the user turn in history so a retry resends it.
        throw describeFailure(error);
      }
      this.messages.push({ role: "assistant", content: message.content });
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
        try {
          if (use.name === "bash") {
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
          content: output,
          ...(failed ? { is_error: true } : {}),
        });
      }
      this.messages.push({ role: "user", content: results });
    }
  }
}
