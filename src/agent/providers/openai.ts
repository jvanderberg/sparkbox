import OpenAI from "openai";
import type { ResponseInputItem, Tool } from "openai/resources/responses/responses";
import {
  applyPatchOperation,
  pageTools,
  runPageTool,
  runShell,
  type ToolOutcome,
  truncate,
} from "../tools.ts";
import { describeFailure, type Prompt, type ProviderSession, type TurnContext } from "./types.ts";

const tools: Tool[] = [
  { type: "shell", environment: { type: "local" } },
  { type: "apply_patch" },
  ...pageTools.map(
    (tool): Tool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      strict: false,
    }),
  ),
];

/** OpenAI models through the Responses API with the shell and apply_patch tools. */
export class OpenAISession implements ProviderSession {
  readonly provider = "openai" as const;
  private client: OpenAI;
  private items: ResponseInputItem[] = [];
  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  }

  reset() {
    this.items = [];
  }
  export() {
    return this.items;
  }
  import(state: unknown) {
    this.items = Array.isArray(state) ? (state as ResponseInputItem[]) : [];
  }

  async run(prompt: Prompt, context: TurnContext) {
    this.items.push({
      role: "user",
      content: [
        ...(prompt.images ?? []).map((image) => ({
          type: "input_image" as const,
          detail: "auto" as const,
          image_url: `data:${image.mime};base64,${image.data}`,
        })),
        { type: "input_text" as const, text: prompt.text || "(see attached images)" },
      ],
    });
    for (let step = 0; step < 200; step++) {
      if (context.signal.aborted) return;
      const textId = crypto.randomUUID();
      let response: OpenAI.Responses.Response;
      try {
        const stream = this.client.responses.stream(
          {
            model: this.model,
            instructions: context.system,
            input: this.items,
            tools,
            store: false,
            reasoning: { effort: "medium" },
          },
          { signal: context.signal },
        );
        stream.on("response.output_text.delta", (event) => context.sink.text(textId, event.delta));
        response = await stream.finalResponse();
      } catch (error) {
        throw describeFailure(error);
      }
      const calls: ResponseInputItem[] = [];
      for (const item of response.output) {
        // Reasoning items must be echoed back for the next step to keep context.
        this.items.push(item as ResponseInputItem);
        if (item.type === "shell_call") {
          const input = { command: item.action.commands.join("\n") };
          context.sink.tool(item.call_id, "shell", { status: "running", input });
          const outputs: {
            stdout: string;
            stderr: string;
            outcome: { type: "exit"; exit_code: number } | { type: "timeout" };
          }[] = [];
          let failed = false;
          let combined = "";
          for (const command of item.action.commands) {
            if (context.signal.aborted) break;
            const result = await runShell(context.sandbox, command, {
              timeoutMs: item.action.timeout_ms ?? undefined,
              signal: context.signal,
              onOutput: (chunk) => {
                combined += chunk;
                context.sink.tool(item.call_id, "shell", {
                  status: "running",
                  input,
                  output: combined.slice(-4000),
                });
              },
            });
            const limit = item.action.max_output_length ?? 16_000;
            outputs.push({
              stdout: truncate(result.stdout, limit),
              stderr: truncate(result.stderr, limit),
              outcome: result.timedOut
                ? { type: "timeout" }
                : { type: "exit", exit_code: result.exitCode },
            });
            combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
            if (result.exitCode !== 0) failed = true;
          }
          context.sink.tool(item.call_id, "shell", {
            status: failed ? "error" : "done",
            input,
            output: truncate(
              outputs
                .map((entry) =>
                  [
                    entry.stdout,
                    entry.stderr,
                    entry.outcome.type === "exit" && entry.outcome.exit_code !== 0
                      ? `[exit code ${entry.outcome.exit_code}]`
                      : entry.outcome.type === "timeout"
                        ? "[timed out]"
                        : "",
                  ]
                    .filter(Boolean)
                    .join("\n"),
                )
                .join("\n"),
            ),
          });
          calls.push({
            type: "shell_call_output",
            call_id: item.call_id,
            output: outputs,
            max_output_length: item.action.max_output_length ?? null,
          } as ResponseInputItem);
        } else if (item.type === "function_call") {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(item.arguments || "{}");
          } catch {
            // Invalid JSON: report it as a tool error below.
          }
          context.sink.tool(item.call_id, item.name, { status: "running", input: args });
          const result = (await runPageTool(item.name, args, {
            sandbox: context.sandbox,
            preview: context.preview,
            signal: context.signal,
            fetchProxy: context.fetchProxy,
          }).catch(
            (error): ToolOutcome => ({
              output: error instanceof Error ? error.message : String(error),
              error: true,
            }),
          )) ?? { output: `Unknown tool: ${item.name}`, error: true };
          context.sink.tool(item.call_id, item.name, {
            status: result.error ? "error" : "done",
            input: args,
            output: result.output,
          });
          calls.push({
            type: "function_call_output",
            call_id: item.call_id,
            output: result.image
              ? [
                  { type: "input_text", text: result.output },
                  {
                    type: "input_image",
                    detail: "auto",
                    image_url: `data:${result.image.mime};base64,${result.image.data}`,
                  },
                ]
              : result.output,
          } as ResponseInputItem);
        } else if (item.type === "apply_patch_call") {
          const operation = item.operation as { type: string; path: string; diff?: string };
          const input = { path: operation.path, command: operation.type, content: operation.diff };
          context.sink.tool(item.call_id, "apply_patch", { status: "running", input });
          const result = await applyPatchOperation(context.sandbox, operation).catch((error) => ({
            output: error instanceof Error ? error.message : String(error),
            error: true,
          }));
          context.sink.tool(item.call_id, "apply_patch", {
            status: result.error ? "error" : "done",
            input,
            output: result.output,
          });
          calls.push({
            type: "apply_patch_call_output",
            call_id: item.call_id,
            status: result.error ? "failed" : "completed",
            output: result.output,
          } as ResponseInputItem);
        }
      }
      if (response.status === "incomplete") {
        context.sink.status(
          `The response was cut short (${response.incomplete_details?.reason ?? "unknown reason"}).`,
        );
        return;
      }
      if (!calls.length) return;
      this.items.push(...calls);
    }
  }
}
