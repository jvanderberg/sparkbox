import type { AgentEvent, QueuedPrompt } from "./protocol.ts";

export const historyLimit = 500;
export const historyByteLimit = 10 * 1024 * 1024;
const retainedTypes = new Set([
  "user",
  "text",
  "tool",
  "approval",
  "resolved",
  "status",
  "done",
  "error",
]);
const encodedSizes = new WeakMap<AgentEvent, number>();
const encoder = new TextEncoder();
function encodedSize(event: AgentEvent) {
  const cached = encodedSizes.get(event);
  if (cached !== undefined) return cached;
  const size = encoder.encode(JSON.stringify(event)).byteLength;
  encodedSizes.set(event, size);
  return size;
}
export function retainEvent(events: AgentEvent[], event: AgentEvent) {
  if (!retainedTypes.has(event.type)) return;
  // Runtime connection chatter is current state, not part of the conversation.
  if (event.type === "status" && event.text === "Checking API key and runtime…") return;
  const existing = events.findIndex((e) => e.id === event.id && e.type === event.type);
  const next: AgentEvent = {
    type: event.type,
    id: event.id,
    text: event.text.slice(-200000),
    details: event.details?.slice(-20000),
    cost: event.cost,
    images: event.type === "user" ? event.images : undefined,
    requestId: event.requestId,
    outcome: event.outcome,
    workingStartedAt: event.workingStartedAt,
  };
  if (existing >= 0) {
    if (event.type === "text")
      next.text = `${events[existing]?.text ?? ""}${next.text}`.slice(-200000);
    events[existing] = next;
  } else events.push(next);
  // Each retained event is replaced, never mutated. Size new deltas once rather
  // than serializing up to 10 MiB of unchanged transcript on every token.
  let bytes = 2 + Math.max(0, events.length - 1) + events.reduce((n, e) => n + encodedSize(e), 0);
  while (events.length > historyLimit || bytes > historyByteLimit) {
    const removed = events.shift();
    if (!removed) break;
    bytes -= encodedSize(removed) + (events.length ? 1 : 0);
  }
}
export class AgentReplay {
  readonly events: AgentEvent[] = [];
  private runtimeReady = false;
  private working = false;
  private workingStartedAt: string | undefined;
  private currentError: string | null = null;
  private providers = new Set<"claude" | "opencode">();
  private savedProviders: AgentEvent["savedProviders"];
  private failedProviders = new Set<"claude" | "opencode">();
  private stopping = false;
  private queued: QueuedPrompt[] = [];
  /** The participant asked to stop; the turn is winding down but not finished. */
  requestStop() {
    this.stopping = true;
  }
  /** The ordered messages waiting for the running turn. */
  setQueued(queued: QueuedPrompt[]) {
    this.queued = queued;
  }
  accept(event: AgentEvent) {
    retainEvent(this.events, event);
    if (event.replayed) return;
    if (event.type === "error") {
      this.currentError = event.text;
      if (event.credentialFailure && event.provider) this.failedProviders.add(event.provider);
    } else if (event.type === "user" || event.type === "configured") this.currentError = null;
    if (event.type === "state") {
      this.runtimeReady = event.runtimeReady ?? false;
      this.working = event.working ?? false;
      if (!this.working) this.stopping = false;
      this.workingStartedAt = this.working ? event.workingStartedAt : undefined;
      this.providers = new Set(event.configuredProviders ?? []);
      if (event.savedProviders !== undefined) this.savedProviders = event.savedProviders;
      if (event.failedProviders !== undefined)
        this.failedProviders = new Set(event.failedProviders);
    } else if (event.type === "ready") this.runtimeReady = true;
    else if (event.type === "configured" && (event.id === "claude" || event.id === "opencode")) {
      this.providers.add(event.id);
      this.savedProviders = [
        ...new Set<"claude" | "opencode">([...(this.savedProviders ?? []), event.id]),
      ];
      this.failedProviders.delete(event.id);
    } else if (event.type === "status" && event.text === "Working") {
      this.working = true;
      this.stopping = false;
      this.workingStartedAt = event.workingStartedAt;
    } else if (event.type === "done" || event.type === "error") {
      this.working = false;
      this.stopping = false;
      this.workingStartedAt = undefined;
    }
  }
  snapshot(): AgentEvent {
    return {
      type: "state",
      id: "runtime-state",
      text: this.working ? "Working" : this.runtimeReady ? "Ready" : "Connecting",
      runtimeReady: this.runtimeReady,
      working: this.working,
      workingStartedAt: this.workingStartedAt,
      configuredProviders: [...this.providers],
      savedProviders: this.savedProviders,
      failedProviders: [...this.failedProviders],
      currentError: this.currentError,
      stopping: this.stopping,
      queued: this.queued,
    };
  }
}

export function redactAgentEvent(event: AgentEvent, secrets: (string | undefined)[]): AgentEvent {
  let json = JSON.stringify(event);
  for (const secret of secrets)
    if (secret) json = json.replaceAll(JSON.stringify(secret).slice(1, -1), "[redacted]");
  return JSON.parse(json) as AgentEvent;
}
