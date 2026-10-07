import type { AgentImage } from "../../agents/images.ts";
import type { Sandbox } from "../../sandbox/types.ts";
import type { PreviewController } from "../preview-controller.ts";

export type ProviderId = "sparkbox" | "anthropic" | "openai" | "openrouter";

export const providers: Record<
  ProviderId,
  { label: string; defaultModel: string; credential: string; keyHint: string; models: string[] }
> = {
  sparkbox: {
    label: "Sparkbox",
    defaultModel: "z-ai/glm-5.3-flash",
    credential: "Invite code",
    keyHint: "Invite code from the person who shared this",
    models: ["z-ai/glm-5.3-flash"],
  },
  anthropic: {
    label: "Claude",
    defaultModel: "claude-opus-5-5",
    credential: "Anthropic API key",
    keyHint: "sk-ant-…",
    models: ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-6-sol",
    credential: "OpenAI API key",
    keyHint: "sk-…",
    models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.5"],
  },
  openrouter: {
    label: "OpenRouter",
    defaultModel: "z-ai/glm-5.3-flash",
    credential: "OpenRouter API key",
    keyHint: "sk-or-…",
    models: [
      "z-ai/glm-5.3-flash",
      "anthropic/claude-sonnet-5",
      "openai/gpt-6-sol",
      "moonshotai/kimi-k2.5",
      "qwen/qwen3-coder",
    ],
  },
};

export const providerIds = Object.keys(providers) as ProviderId[];

export type Prompt = { text: string; images?: AgentImage[] };

/** What a provider session emits while a turn runs. */
export interface TurnSink {
  /** Streaming assistant text; the same id appends. */
  text(id: string, delta: string): void;
  /** A tool call row; the same id replaces the previous one. */
  tool(id: string, name: string, details: ToolDetails): void;
  /** Non-fatal notices. */
  status(text: string): void;
}

export type ToolDetails = {
  status?: "running" | "done" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
};

export type TurnContext = {
  sandbox: Sandbox;
  signal: AbortSignal;
  system: string;
  sink: TurnSink;
  preview?: PreviewController;
};

/** One provider-specific conversation. History stays in memory per session. */
export interface ProviderSession {
  readonly provider: ProviderId;
  readonly model: string;
  run(prompt: Prompt, context: TurnContext): Promise<void>;
  /** Forget the conversation. */
  reset(): void;
  /** Exported transcript for persistence. */
  export(): unknown;
  import(state: unknown): void;
}

export type SessionFactory = (options: { apiKey: string; model: string }) => ProviderSession;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: "credential" | "billing" | "rate" | "model" | "network" | "other" = "other",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Map SDK failures to short, safe messages. Never includes request bodies. */
export function describeFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const value = error as { status?: number; message?: string; name?: string } | null;
  const status = value?.status;
  const message = `${value?.name ?? ""} ${value?.message ?? ""}`;
  if (status === 401 || /api key|authentication|unauthorized/i.test(message))
    return new ProviderError(
      "The API key was rejected. Check the key and try again.",
      status,
      "credential",
    );
  if (status === 402 || /credit|balance|billing|insufficient/i.test(message))
    return new ProviderError("This account has insufficient credits.", status, "billing");
  if (status === 403)
    return new ProviderError(
      "This API key does not have permission for the model.",
      status,
      "credential",
    );
  if (status === 404 || /model.*(not found|unavailable|does not exist)/i.test(message))
    return new ProviderError("The selected model is unavailable to this account.", status, "model");
  if (status === 429 || /rate.?limit/i.test(message))
    return new ProviderError(
      "The provider is rate limiting requests. Wait a moment, then retry.",
      status,
      "rate",
    );
  if (/abort/i.test(message)) return new ProviderError("Stopped.", status, "other");
  if (/fetch failed|network|CORS|Failed to fetch/i.test(message))
    return new ProviderError(
      "Could not reach the provider. Check your connection; the provider must allow browser requests.",
      status,
      "network",
    );
  if (status && status >= 500)
    return new ProviderError(
      "The provider returned a server error. Retry in a moment.",
      status,
      "other",
    );
  return new ProviderError("The provider request failed.", status, "other");
}
