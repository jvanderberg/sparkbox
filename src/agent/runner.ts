import { retainEvent } from "../agents/history.ts";
import type { AgentImage } from "../agents/images.ts";
import type { AgentEvent, QueuedPrompt } from "../agents/protocol.ts";
import { agentQueueLimit } from "../agents/protocol.ts";
import { kv } from "../sandbox/storage.ts";
import type { Sandbox } from "../sandbox/types.ts";
import { compactionNotice } from "./compaction.ts";
import type { GitHubController, GitHubState } from "./github-controller.ts";
import type { PreviewController } from "./preview-controller.ts";
import { AnthropicSession } from "./providers/anthropic.ts";
import { OpenAISession } from "./providers/openai.ts";
import { OpenRouterSession } from "./providers/openrouter.ts";
import {
  describeFailure,
  type ProviderId,
  type ProviderSession,
  type ToolDetails,
} from "./providers/types.ts";
import { withSecrets } from "./secrets.ts";
import { settings } from "./settings.ts";
import { systemPrompt } from "./system-prompt.ts";

export type RunnerInput =
  | {
      type: "prompt";
      provider: ProviderId;
      text: string;
      id?: string;
      images?: AgentImage[];
      queue?: boolean;
    }
  | { type: "stop" }
  | { type: "unqueue"; id: string }
  | { type: "steer"; id: string }
  | { type: "reset" };

export type RunnerOptions = {
  workspace: string;
  sandbox: Sandbox;
  networkEnabled: () => boolean;
  /** The host fetch proxy and the invite token, when both exist. */
  fetchProxy?: () => { url: string; token: string } | undefined;
  /** Project secrets: redacted from what the model sees, substituted in download URLs. */
  secrets?: () => Record<string, string>;
  previewPort: number;
  /** Errors the preview page reported since it was started, oldest first. */
  previewErrors?: () => string[];
  /** The preview tool's backend. */
  preview?: PreviewController;
  /** Prompt tokens past which the oldest half of the conversation is summarized; 0 or absent is off. */
  contextLimit?: () => number;
  /** The github tool's backend, and the state the prompt reports each turn. */
  github?: GitHubController;
  githubState?: () => GitHubState;
  /** Test seam: build a session instead of reading saved keys. */
  createSession?: (provider: ProviderId, model: string) => ProviderSession;
};

/**
 * The in-browser agent loop. It plays the role of the Civic Spark runner: it
 * accepts the same prompt/stop/queue inputs and emits the same event stream
 * the chat UI renders, but the model calls and tool execution happen here.
 */
export class AgentRunner {
  readonly events: AgentEvent[] = [];
  private listeners = new Set<(event: AgentEvent) => void>();
  private sessions = new Map<string, ProviderSession>();
  private queued: QueuedPrompt[] = [];
  private current: { provider: ProviderId; controller: AbortController } | null = null;
  private stopping = false;
  private workingStartedAt: string | undefined;
  private loaded: Promise<void>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private options: RunnerOptions) {
    this.loaded = this.restore();
  }

  get working() {
    return this.current !== null;
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The current snapshot, as the server would send on attach. */
  async attach(listener: (event: AgentEvent) => void) {
    await this.loaded;
    for (const event of this.events) listener({ ...event, replayed: true });
    listener(this.stateEvent());
    return this.subscribe(listener);
  }

  send(input: RunnerInput) {
    switch (input.type) {
      case "prompt":
        return this.prompt(input);
      case "stop":
        return this.stop();
      case "unqueue":
        this.queued = this.queued.filter((message) => message.id !== input.id);
        this.emit(this.stateEvent());
        return;
      case "steer": {
        const message = this.queued.find((entry) => entry.id === input.id);
        if (!message) return;
        this.queued = this.queued.filter((entry) => entry.id !== input.id);
        const rest = this.queued;
        this.queued = [];
        this.stop();
        this.queued = [message, ...rest];
        if (!this.current) this.drain();
        return;
      }
      case "reset":
        this.stop();
        this.events.length = 0;
        for (const session of this.sessions.values()) session.reset();
        this.sessions.clear();
        void kv.delete("transcripts", this.options.workspace);
        for (const provider of ["sparkbox", "anthropic", "openai", "openrouter"] as ProviderId[])
          void kv.delete("sessions", `${this.options.workspace}:${provider}`);
        this.emit(this.stateEvent());
        return;
    }
  }

  private emit(event: AgentEvent) {
    retainEvent(this.events, event);
    for (const listener of this.listeners) listener(event);
    if (event.type !== "state") this.scheduleSave();
  }

  private stateEvent(): AgentEvent {
    return {
      type: "state",
      id: crypto.randomUUID(),
      text: "",
      runtimeReady: true,
      working: this.working,
      workingStartedAt: this.workingStartedAt,
      stopping: this.stopping,
      queued: this.queued,
    };
  }

  private session(provider: ProviderId): ProviderSession {
    const model = provider === "sparkbox" ? "sparkbox" : settings.model(provider);
    const id = `${provider}:${model}`;
    let session = this.sessions.get(id);
    if (!session) {
      if (this.options.createSession) session = this.options.createSession(provider, model);
      else {
        const key = settings.key(provider);
        if (!key) throw new Error(`Add an API key for ${provider} first.`);
        session =
          provider === "anthropic"
            ? new AnthropicSession(key, model)
            : provider === "openai"
              ? new OpenAISession(key, model)
              : provider === "sparkbox"
                ? new OpenRouterSession(key, model, {
                    baseURL: `${location.origin}/api/agent`,
                    provider: "sparkbox",
                  })
                : new OpenRouterSession(key, model);
      }
      // Keep the thread when only the model changed within a provider.
      for (const [other, existing] of this.sessions)
        if (other.startsWith(`${provider}:`)) {
          session.import(existing.export());
          this.sessions.delete(other);
        }
      this.sessions.set(id, session);
    }
    return session;
  }

  private prompt(input: Extract<RunnerInput, { type: "prompt" }>) {
    const id = input.id ?? crypto.randomUUID();
    if (this.current || this.stopping) {
      if (!input.queue) {
        this.emit({ type: "error", id, text: "A turn is already running.", requestId: id });
        return;
      }
      if (this.queued.length >= agentQueueLimit) return;
      this.queued.push({ id, text: input.text, ...(input.images ? { images: input.images } : {}) });
      this.emit(this.stateEvent());
      return;
    }
    void this.runTurn(input.provider, { id, text: input.text, images: input.images });
  }

  private drain() {
    const next = this.queued.shift();
    if (!next) return;
    void this.runTurn(settings.provider(), next);
  }

  private async runTurn(provider: ProviderId, message: QueuedPrompt) {
    const controller = new AbortController();
    this.current = { provider, controller };
    this.workingStartedAt = new Date().toISOString();
    this.emit({ type: "user", id: message.id, text: message.text, images: message.images });
    this.emit({
      type: "status",
      id: crypto.randomUUID(),
      text: "Working",
      workingStartedAt: this.workingStartedAt,
    });
    this.emit(this.stateEvent());
    let outcome: "success" | "failed" | "stopped" = "success";
    try {
      const session = this.session(provider);
      await this.compactIfNeeded(session, controller.signal);
      const files = await this.options.sandbox.listFiles();
      const brief = files.includes("PROJECT.md")
        ? await this.options.sandbox.readText("PROJECT.md").catch(() => undefined)
        : undefined;
      const secrets = this.options.secrets?.() ?? {};
      const system = systemPrompt({
        provider,
        files,
        secretNames: Object.keys(secrets),
        networkEnabled: this.options.networkEnabled(),
        previewPort: this.options.previewPort,
        projectBrief: brief?.slice(0, 8000),
        previewErrors: this.options.previewErrors?.() ?? [],
        github: this.options.githubState?.(),
      });
      await session.run(
        { text: message.text, images: message.images },
        {
          sandbox: withSecrets(this.options.sandbox, secrets),
          signal: controller.signal,
          system,
          preview: this.options.preview,
          github: this.options.github,
          fetchProxy: this.options.fetchProxy?.(),
          secrets,
          sink: {
            text: (id, delta) => {
              if (!controller.signal.aborted) this.emit({ type: "text", id, text: delta });
            },
            tool: (id, name, details: ToolDetails) => {
              if (!controller.signal.aborted)
                this.emit({ type: "tool", id, text: name, details: JSON.stringify(details) });
            },
            status: (text) => this.emit({ type: "status", id: crypto.randomUUID(), text }),
          },
        },
      );
      if (controller.signal.aborted) outcome = "stopped";
      else await this.compactIfNeeded(session, controller.signal);
      void this.persistSession(provider, session);
    } catch (error) {
      if (controller.signal.aborted) outcome = "stopped";
      else {
        outcome = "failed";
        const failure = describeFailure(error);
        // The chat shows a short message; the console keeps the raw status,
        // provider text and request id for diagnosis. Never the key or body.
        const raw = error as { status?: number; message?: string; requestID?: string } | null;
        console.warn(`Provider request failed (${provider})`, {
          status: raw?.status,
          message: raw?.message,
          requestId: raw?.requestID,
        });
        const message =
          error instanceof Error && !("status" in error) ? error.message : failure.message;
        this.emit({
          type: "error",
          id: crypto.randomUUID(),
          text: message,
          credentialFailure: failure.kind === "credential",
          billingFailure: failure.kind === "billing",
        });
      }
    } finally {
      // Files written during the turn must outlive a reload or a runtime crash.
      void this.options.sandbox.flush?.().catch(() => {});
      this.current = null;
      this.stopping = false;
      this.workingStartedAt = undefined;
      this.emit({
        type: "status",
        id: crypto.randomUUID(),
        text: outcome === "stopped" ? "Stopped" : "Turn complete",
      });
      this.emit({
        type: "done",
        id: crypto.randomUUID(),
        text: "",
        outcome,
        requestId: message.id,
      });
      this.emit(this.stateEvent());
      if (outcome !== "stopped") this.drain();
    }
  }

  private stop() {
    if (!this.current) {
      this.queued = [];
      this.emit(this.stateEvent());
      return;
    }
    this.stopping = true;
    this.queued = [];
    this.current.controller.abort();
    this.emit(this.stateEvent());
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void kv.set("transcripts", this.options.workspace, this.events.slice(-400));
    }, 500);
  }

  /**
   * Fold the oldest half of the conversation into a summary when the last
   * prompt went over the deployment's limit. Runs before a turn (so a
   * session restored from storage is checked too) and after it (so the
   * stored session and the next prompt are already small). A failed
   * compaction is reported and the turn goes on with the full history.
   */
  private async compactIfNeeded(session: ProviderSession, signal: AbortSignal) {
    const limit = this.options.contextLimit?.() ?? 0;
    if (!limit) return;
    const promptTokens = session.promptTokens();
    if (promptTokens <= limit) return;
    this.emit({
      type: "status",
      id: crypto.randomUUID(),
      text: `Compacting the conversation (about ${promptTokens.toLocaleString()} tokens)…`,
    });
    try {
      const result = await session.compact(0.5, signal);
      if (result)
        this.emit({
          type: "status",
          id: crypto.randomUUID(),
          text: compactionNotice({ ...result, promptTokens }, limit),
        });
    } catch (error) {
      if (signal.aborted) return;
      this.emit({
        type: "status",
        id: crypto.randomUUID(),
        text: `Could not compact the conversation: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async persistSession(provider: ProviderId, session: ProviderSession) {
    try {
      await kv.set("sessions", `${this.options.workspace}:${provider}`, session.export());
    } catch {
      // Conversation context is a convenience; the transcript is still shown.
    }
  }

  private async restore() {
    const transcript = await kv.get<AgentEvent[]>("transcripts", this.options.workspace);
    if (transcript) for (const event of transcript) retainEvent(this.events, event);
    for (const provider of ["sparkbox", "anthropic", "openai", "openrouter"] as ProviderId[]) {
      const state = await kv.get("sessions", `${this.options.workspace}:${provider}`);
      if (!state || !settings.key(provider)) continue;
      try {
        this.session(provider).import(state);
      } catch {
        // Missing key: the thread is restored once a key is added.
      }
    }
  }
}
