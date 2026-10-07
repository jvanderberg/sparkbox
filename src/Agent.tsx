import { ArrowDown, GitCompareArrows, Paperclip, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentImages, readAgentImage } from "./AgentImages.tsx";
import { AgentTimeline } from "./AgentTimeline.tsx";
import { beginOpenRouterLogin } from "./agent/openrouter-auth.ts";
import { type ProviderId, providerIds, providers } from "./agent/providers/types.ts";
import type { AgentRunner } from "./agent/runner.ts";
import { settings } from "./agent/settings.ts";
import { retainEvent } from "./agents/history.ts";
import { type AgentImage, agentImagesSchema, imageCountLimit } from "./agents/images.ts";
import { type AgentEvent, agentQueueLimit, type QueuedPrompt } from "./agents/protocol.ts";
import { Button } from "./vendor/t3code/Button.tsx";
import { ComposerBanner } from "./vendor/t3code/ComposerBanner.tsx";
import { ComposerPrimaryActions } from "./vendor/t3code/ComposerPrimaryActions.tsx";
import { ComposerSurface } from "./vendor/t3code/ComposerSurface.tsx";

/**
 * The chat panel. The T3 Code composer and timeline are unchanged from Civic
 * Spark; the transport is the in-browser runner instead of a WebSocket.
 */
export function Agent({
  runner,
  visible,
  dirty,
  onUpdated,
  onOpenFile,
  onReview,
  onWorkingChange,
}: {
  runner: AgentRunner;
  visible: boolean;
  dirty: boolean;
  onUpdated: () => void;
  onOpenFile: (path: string) => void;
  onReview: () => void;
  onWorkingChange?: (working: boolean) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const stickToBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerBottom = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const bottom = composerBottom.current;
    if (!bottom) return;
    const resize = new ResizeObserver(() => {
      bottom.parentElement?.style.setProperty(
        "--chat-bottom-height",
        `${bottom.getBoundingClientRect().height}px`,
      );
    });
    resize.observe(bottom);
    return () => resize.disconnect();
  }, []);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [provider, setProvider] = useState<ProviderId>(() => settings.provider());
  const [model, setModel] = useState(() => settings.model(provider));
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(() => Boolean(settings.key(provider)));
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<AgentImage[]>([]);
  const imagesRef = useRef<AgentImage[]>([]);
  imagesRef.current = images;
  const fileInput = useRef<HTMLInputElement>(null);
  const [readingImages, setReadingImages] = useState(false);
  const readingImagesRef = useRef(false);
  const [queued, setQueued] = useState<QueuedPrompt[]>([]);
  const queuedRef = useRef<QueuedPrompt[]>([]);
  queuedRef.current = queued;
  const stoppingRef = useRef(false);
  const [working, setWorking] = useState(false);
  const [workingStartedAt, setWorkingStartedAt] = useState<string>();
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const updatedCallback = useRef(onUpdated);
  updatedCallback.current = onUpdated;
  const workingCallback = useRef(onWorkingChange);
  workingCallback.current = onWorkingChange;

  useEffect(() => {
    settings.setProvider(provider);
    setModel(settings.model(provider));
    setHasKey(Boolean(settings.key(provider)));
    setKey("");
  }, [provider]);

  useEffect(() => {
    mounted.current = true;
    // Each effect run owns its subscription. StrictMode replays effects, and a
    // shared flag would leave the first subscription attached and double every delta.
    let active = true;
    let detach = () => {};
    void runner
      .attach((event) => {
        if (!active || !mounted.current) return;
        if (event.type === "state") {
          setWorking(Boolean(event.working));
          setWorkingStartedAt(event.workingStartedAt);
          setQueued(event.queued ?? []);
          stoppingRef.current = Boolean(event.stopping);
          return;
        }
        if (event.type === "status" && event.text === "Working") {
          setWorking(true);
          setWorkingStartedAt(event.workingStartedAt);
        }
        if (event.type === "error") setError(event.text);
        if (event.type === "done" && !event.replayed) updatedCallback.current();
        setEvents((previous) => {
          const next = [...previous];
          retainEvent(next, event);
          return next;
        });
      })
      .then((unsubscribe) => {
        detach = unsubscribe;
        if (!active) unsubscribe();
      });
    return () => {
      active = false;
      mounted.current = false;
      detach();
    };
  }, [runner]);

  useEffect(() => {
    workingCallback.current?.(working);
  }, [working]);

  useEffect(() => {
    if (visible && events.length && stickToBottom.current)
      log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [events, visible]);

  async function addImages(files: File[]) {
    if (readingImagesRef.current) return;
    if (imagesRef.current.length + files.length > imageCountLimit) {
      setError(`Attach up to ${imageCountLimit} images per message.`);
      return;
    }
    readingImagesRef.current = true;
    setReadingImages(true);
    try {
      const additions: AgentImage[] = [];
      for (const file of files) additions.push(await readAgentImage(file));
      const parsed = agentImagesSchema.safeParse([...imagesRef.current, ...additions]);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid images.");
      if (mounted.current) {
        setImages(parsed.data);
        setError("");
      }
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : "Could not attach images.");
    } finally {
      readingImagesRef.current = false;
      if (mounted.current) setReadingImages(false);
    }
  }

  const ready = hasKey;
  const hasConversation = events.some((event) => ["user", "text", "tool"].includes(event.type));
  const stateLabel = working ? "Working" : ready ? "Ready" : "Add API key";

  function submitText(text: string) {
    const attached = imagesRef.current;
    const queueing = working || stoppingRef.current;
    if (
      (!text.trim() && !attached.length) ||
      readingImagesRef.current ||
      !ready ||
      (queueing && queuedRef.current.length >= agentQueueLimit) ||
      dirty ||
      !visible
    )
      return false;
    stickToBottom.current = true;
    setAtBottom(true);
    setError("");
    const id = crypto.randomUUID();
    runner.send({
      type: "prompt",
      provider,
      text,
      id,
      ...(attached.length ? { images: attached } : {}),
      ...(queueing ? { queue: true } : {}),
    });
    setPrompt("");
    if (attached.length) setImages([]);
    if (composer.current) composer.current.style.height = "auto";
    return true;
  }

  function restoreQueued(waiting: QueuedPrompt[]) {
    if (!waiting.length) return;
    setPrompt((draft) =>
      [draft, ...waiting.map((message) => message.text)]
        .map((text) => text.trim())
        .filter((text) => text.length > 0)
        .join("\n\n"),
    );
    const returning = waiting.flatMap((message) => message.images ?? []);
    if (!returning.length) return;
    const draft = imagesRef.current;
    const parsed = agentImagesSchema.safeParse([...draft, ...returning].slice(0, imageCountLimit));
    setImages(parsed.success ? parsed.data : draft);
  }
  function cancelQueued(id: string) {
    const waiting = queuedRef.current.find((message) => message.id === id);
    if (!waiting) return;
    runner.send({ type: "unqueue", id });
    restoreQueued([waiting]);
  }
  function sendQueuedNow(id: string) {
    if (!queuedRef.current.some((message) => message.id === id)) return;
    if (working) endTurnLocally();
    runner.send({ type: "steer", id });
  }
  function endTurnLocally() {
    stoppingRef.current = true;
    setWorking(false);
    setWorkingStartedAt(undefined);
  }
  function interrupt() {
    endTurnLocally();
    restoreQueued(queuedRef.current);
    setQueued([]);
    runner.send({ type: "stop" });
  }
  function saveKey() {
    const value = key.trim();
    if (!value) return;
    settings.setKey(provider, value);
    setHasKey(true);
    setKey("");
    setError("");
  }
  function clearKey() {
    settings.setKey(provider, "");
    setHasKey(false);
  }

  const info = providers[provider];
  return (
    <section className="workspace-panel agent-panel" hidden={!visible}>
      <header className="chat-header">
        <span>Agent</span>
        <div>
          <button type="button" onClick={onReview}>
            <GitCompareArrows size={14} /> Review changes
          </button>
          <button
            type="button"
            aria-label="Agent connection settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <Settings2 size={15} /> Connection
          </button>
        </div>
      </header>
      <div
        ref={log}
        className="agent-conversation"
        role="log"
        aria-label="Agent conversation"
        aria-live="polite"
        onScroll={() => {
          const el = log.current;
          if (!el) return;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stickToBottom.current = bottom;
          setAtBottom(bottom);
        }}
      >
        <div className="chat-thread">
          {!hasConversation && (
            <div className="chat-empty flex h-full items-center justify-center">
              <p className="text-placeholder text-sm">
                Describe the app you want to build or change.
              </p>
            </div>
          )}
          <AgentTimeline
            events={events}
            onOpenFile={onOpenFile}
            working={working}
            workingStartedAt={workingStartedAt}
            awaitingInput={false}
            queued={queued}
            onSendQueuedNow={sendQueuedNow}
            onCancelQueued={cancelQueued}
          />
        </div>
      </div>
      {!atBottom && hasConversation && (
        <button
          type="button"
          className="chat-jump"
          onClick={() => {
            stickToBottom.current = true;
            log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
          }}
        >
          <ArrowDown size={14} /> Latest
        </button>
      )}
      <div className="chat-bottom" ref={composerBottom}>
        <ComposerSurface.Shell className="chat-composer-wrap">
          <ComposerSurface.Host>
            {(error || dirty || settingsOpen || !ready) && (
              <ComposerBanner.Attachment>
                <ComposerBanner.Root variant={error ? "error" : "default"}>
                  {error && (
                    <div className="chat-feedback error" role="alert">
                      <span>{error}</span>
                      <button
                        type="button"
                        aria-label="Dismiss agent error"
                        onClick={() => setError("")}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {dirty && (
                    <div className="chat-feedback">
                      Save your file edits before sending a request.
                    </div>
                  )}
                  {(settingsOpen || !ready) && (
                    <div className="chat-connection">
                      <div>
                        <strong>Connect {info.label}</strong>
                        <span>{model}</span>
                      </div>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveKey();
                        }}
                      >
                        {hasKey ? (
                          <span className="chat-saved-key">API key saved in this browser</span>
                        ) : (
                          <input
                            type="password"
                            aria-label={info.credential}
                            autoComplete="off"
                            value={key}
                            onChange={(event) => setKey(event.target.value)}
                            placeholder={info.keyHint}
                          />
                        )}
                        {hasKey ? (
                          <Button size="xs" variant="outline" type="button" onClick={clearKey}>
                            Remove key
                          </Button>
                        ) : (
                          <Button size="xs" variant="outline" type="submit" disabled={!key.trim()}>
                            Save key
                          </Button>
                        )}
                      </form>
                      {provider === "openrouter" && !hasKey && (
                        <Button
                          size="xs"
                          variant="outline"
                          type="button"
                          onClick={() => void beginOpenRouterLogin()}
                        >
                          Sign in with OpenRouter
                        </Button>
                      )}
                      <label className="chat-workspace-id">
                        Model
                        <input
                          aria-label="Model"
                          list={`models-${provider}`}
                          autoComplete="off"
                          value={model}
                          onChange={(event) => {
                            setModel(event.target.value);
                            settings.setModel(provider, event.target.value);
                          }}
                        />
                        <datalist id={`models-${provider}`}>
                          {info.models.map((name) => (
                            <option key={name} value={name} />
                          ))}
                        </datalist>
                      </label>
                      <small>
                        Keys stay in this browser's storage and go only to {info.label}. Usage is
                        billed to your account.
                      </small>
                      {hasConversation && (
                        <Button
                          size="xs"
                          variant="ghost"
                          type="button"
                          disabled={working}
                          onClick={() => {
                            runner.send({ type: "reset" });
                            setEvents([]);
                          }}
                        >
                          <Trash2 size={14} /> Clear conversation
                        </Button>
                      )}
                    </div>
                  )}
                </ComposerBanner.Root>
              </ComposerBanner.Attachment>
            )}
            <ComposerSurface.Main>
              <form
                className="agent-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitText(prompt);
                }}
              >
                <div
                  data-chat-composer-body="true"
                  className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4"
                >
                  {images.length > 0 && (
                    <AgentImages
                      images={images}
                      disabled={readingImages}
                      onRemove={(id) =>
                        setImages((previous) => previous.filter((image) => image.id !== id))
                      }
                    />
                  )}
                  <textarea
                    onPaste={(event) => {
                      const files = [...event.clipboardData.items]
                        .filter((item) => item.kind === "file")
                        .map((item) => item.getAsFile())
                        .filter((file): file is File => file !== null);
                      if (!files.length) return;
                      if (!event.clipboardData.getData("text/plain")) event.preventDefault();
                      void addImages(files);
                    }}
                    ref={composer}
                    aria-label="Message to agent"
                    rows={3}
                    placeholder="Ask anything"
                    value={prompt}
                    onChange={(event) => {
                      setPrompt(event.target.value);
                      event.target.style.height = "auto";
                      event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        submitText(prompt);
                      }
                    }}
                  />
                </div>
                <div
                  data-chat-composer-footer="true"
                  className="chat-composer-toolbar flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
                >
                  <div className="chat-model">
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      aria-label="Choose images"
                      onChange={(event) => {
                        const files = [...(event.target.files ?? [])];
                        event.target.value = "";
                        void addImages(files);
                      }}
                    />
                    <button
                      className="chat-attach"
                      type="button"
                      aria-label="Attach images"
                      title="Attach images"
                      disabled={readingImages}
                      onClick={() => fileInput.current?.click()}
                    >
                      <Paperclip size={18} />
                    </button>
                    <select
                      aria-label="Agent provider"
                      value={provider}
                      disabled={working}
                      onChange={(event) => {
                        setProvider(event.target.value as ProviderId);
                        setError("");
                      }}
                    >
                      {providerIds.map((id) => (
                        <option key={id} value={id}>
                          {providers[id].label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className={ready || working ? "sr-only" : "chat-readiness"} role="status">
                    {stateLabel}
                  </span>
                  <ComposerPrimaryActions
                    isRunning={working}
                    hasSendableContent={!!prompt.trim() || images.length > 0}
                    isConnecting={false}
                    isSendBusy={readingImages}
                    isEnvironmentUnavailable={!ready}
                    sendDisabledReason={
                      dirty
                        ? "Save file edits first"
                        : queued.length >= agentQueueLimit
                          ? `Up to ${agentQueueLimit} messages can wait for this turn`
                          : null
                    }
                    onInterrupt={interrupt}
                  />
                </div>
              </form>
            </ComposerSurface.Main>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </section>
  );
}
