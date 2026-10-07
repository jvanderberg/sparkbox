import type { Process } from "@wasmer/sdk/browser";
import { Maximize2, Minimize2, Play, ScrollText, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { serveScript } from "./sandbox/serve-script.ts";
import type { WasmerSandbox } from "./sandbox/wasmer.ts";
import "./preview.css";

export const previewPort = 8080;

/** Where the preview iframe loads from. Must be a different origin than the app. */
export function defaultPreviewOrigin() {
  const configured = import.meta.env.VITE_PREVIEW_ORIGIN;
  if (typeof configured === "string" && configured) return configured;
  const { protocol, hostname, port } = location;
  const suffix = port ? `:${port}` : "";
  if (hostname === "127.0.0.1") return `${protocol}//localhost${suffix}`;
  if (hostname === "localhost") return `${protocol}//127.0.0.1${suffix}`;
  // Tailscale Serve publishes the same server on a second port for the preview host.
  if (hostname.endsWith(".ts.net")) return `https://${hostname}:8443`;
  return "";
}

export function usePreview(sandbox: WasmerSandbox | null, origin: string) {
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [logs, setLogs] = useState("");
  const [error, setError] = useState("");
  const [ports, setPorts] = useState<number[]>([]);
  const [pageErrors, setPageErrors] = useState<string[]>([]);
  const pageErrorsRef = useRef<string[]>([]);
  pageErrorsRef.current = pageErrors;
  const process = useRef<Process | null>(null);
  const closeServer = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!sandbox) return;
    return sandbox.onListen(
      (port) => setPorts((known) => (known.includes(port) ? known : [...known, port])),
      (port) => setPorts((known) => known.filter((entry) => entry !== port)),
    );
  }, [sandbox]);

  // The runtime can die mid-session; it rebuilds itself, and the preview
  // server with it is gone until started again.
  useEffect(() => {
    if (!sandbox) return;
    return sandbox.onRestart(() => {
      process.current = null;
      closeServer.current = null;
      setUrl("");
      setRunning(false);
      setPorts([]);
      setError("The sandbox runtime restarted. Start the preview again.");
    });
  }, [sandbox]);

  // Errors reported by the page through the injected reporter script.
  useEffect(() => {
    if (!origin) return;
    let expected = "";
    try {
      expected = new URL(origin).origin;
    } catch {
      return;
    }
    const listener = (event: MessageEvent) => {
      if (event.origin !== expected) return;
      const data = event.data as {
        type?: string;
        message?: string;
        href?: string;
        probe?: boolean;
      } | null;
      if (data?.type !== "sparkbox:page-error" || typeof data.message !== "string") return;
      // Hidden probe frames belong to the agent's preview tool, not the user's view.
      if (data.probe) return;
      const line = `${data.href && data.href !== "/" ? `${data.href}: ` : ""}${data.message}`;
      setPageErrors((previous) => [...previous.slice(-49), line]);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [origin]);

  const urlRef = useRef("");
  urlRef.current = url;
  const startingRef = useRef<Promise<string> | null>(null);

  async function expose(port: number): Promise<string> {
    if (!sandbox) throw new Error("The sandbox is not ready.");
    if (!origin) {
      const message =
        "Set a preview origin in Settings. The preview needs a second origin to serve from.";
      setError(message);
      throw new Error(message);
    }
    try {
      const server = await sandbox.expose(port, origin);
      closeServer.current = server.close;
      setUrl(server.url);
      urlRef.current = server.url;
      setError("");
      return server.url;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }

  /** Start the static server and expose it; resolves with the preview URL. */
  function start(): Promise<string> {
    if (startingRef.current) return startingRef.current;
    if (!sandbox) return Promise.reject(new Error("The sandbox is not ready."));
    const run = (async () => {
      setStarting(true);
      setError("");
      setLogs("");
      setPageErrors([]);
      try {
        await sandbox.writeFile(".sparkbox/serve.mjs", serveScript);
        const started = await sandbox.start(`node .sparkbox/serve.mjs ${previewPort}`, (chunk) =>
          setLogs((text) => (text + chunk).slice(-20_000)),
        );
        process.current = started.process;
        setRunning(true);
        void started.done.then((code) => {
          if (process.current === started.process) {
            process.current = null;
            setRunning(false);
            if (code !== 0) setError(`The preview server exited with code ${code}.`);
          }
        });
        await sandbox.waitForPort(previewPort, 60_000);
        return await expose(previewPort);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally {
        setStarting(false);
        startingRef.current = null;
      }
    })();
    startingRef.current = run;
    return run;
  }

  /** The agent's entry point: the current URL, or a fresh start. */
  function ensureRunning(): Promise<string> {
    if (urlRef.current && process.current) return Promise.resolve(urlRef.current);
    return start();
  }

  async function stop() {
    const current = process.current;
    process.current = null;
    await closeServer.current?.().catch(() => {});
    closeServer.current = null;
    setUrl("");
    if (current) await current.kill().catch(() => {});
    setRunning(false);
  }

  return {
    url,
    running,
    starting,
    logs,
    error,
    ports,
    pageErrors,
    /** Stable accessor for the agent's prompt. */
    recentPageErrors: () => pageErrorsRef.current,
    clearPageErrors: () => setPageErrors([]),
    start,
    ensureRunning,
    stop,
    expose,
  };
}

export function PreviewControls({
  preview,
  disabled,
  onShow,
  onFullScreen,
}: {
  preview: ReturnType<typeof usePreview>;
  disabled: boolean;
  /** Called when a preview is started or exposed, so the panel can be shown. */
  onShow: () => void;
  /** Fill the window with the preview panel. */
  onFullScreen: () => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  return (
    <div className="preview-controls">
      {preview.running ? (
        <button
          type="button"
          className="button small"
          onClick={() => void preview.stop()}
          disabled={disabled}
        >
          <Square size={14} /> Stop preview
        </button>
      ) : (
        <button
          type="button"
          className="button small primary"
          onClick={() => {
            onShow();
            void preview.start().catch(() => {});
          }}
          disabled={disabled || preview.starting}
        >
          <Play size={14} /> {preview.starting ? "Starting…" : "Preview"}
        </button>
      )}
      {preview.url && (
        // Not a link to a new tab: the preview exists only through a service
        // worker registered inside a third-party frame, and browsers that
        // partition storage by top-level site (Safari, Chrome with third-party
        // blocking) would serve the app page there instead.
        <button type="button" className="button small" onClick={onFullScreen}>
          <Maximize2 size={14} /> Full screen
        </button>
      )}
      {preview.ports
        .filter((port) => port !== previewPort || !preview.url)
        .map((port) => (
          <button
            key={port}
            type="button"
            className="button small"
            onClick={() => {
              onShow();
              void preview.expose(port).catch(() => {});
            }}
          >
            Show port {port}
          </button>
        ))}
      <button
        type="button"
        className="button small"
        aria-expanded={logsOpen}
        onClick={() => setLogsOpen(!logsOpen)}
      >
        <ScrollText size={14} /> Logs
      </button>
      {logsOpen && (
        <pre className="preview-logs" role="log" aria-label="Preview server logs">
          {preview.logs || "No output yet."}
          {preview.pageErrors.length > 0 && `\n\nPage errors:\n${preview.pageErrors.join("\n")}`}
        </pre>
      )}
    </div>
  );
}

export function PreviewPanel({
  preview,
  visible,
  full = false,
  onExitFullScreen,
}: {
  preview: ReturnType<typeof usePreview>;
  visible: boolean;
  full?: boolean;
  onExitFullScreen?: () => void;
}) {
  return (
    <section className="workspace-panel preview-panel" aria-label="Preview" hidden={!visible}>
      {full && (
        <button
          type="button"
          className="preview-exit-full"
          onClick={onExitFullScreen}
          aria-label="Exit full screen"
          title="Exit full screen (Esc)"
        >
          <Minimize2 size={16} /> Exit full screen
        </button>
      )}
      {preview.error && (
        <p className="preview-error" role="alert">
          {preview.error}
        </p>
      )}
      {preview.pageErrors.length > 0 && (
        <div className="preview-page-errors" role="status">
          <span>
            {preview.pageErrors.length === 1
              ? "1 page error"
              : `${preview.pageErrors.length} page errors`}
            : {preview.pageErrors[preview.pageErrors.length - 1]}
          </span>
          <button type="button" onClick={preview.clearPageErrors} aria-label="Clear page errors">
            Clear
          </button>
        </div>
      )}
      {preview.url ? (
        <iframe
          className="preview-frame"
          title="App preview"
          src={preview.url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
        />
      ) : (
        <div className="preview-empty">
          <p>
            {preview.running || preview.starting
              ? "Waiting for the server…"
              : "Start the preview to see your app here."}
          </p>
          <button
            type="button"
            className="button primary"
            onClick={() => void preview.start().catch(() => {})}
            disabled={preview.starting || preview.running}
          >
            <Play size={14} /> {preview.starting ? "Starting…" : "Preview"}
          </button>
        </div>
      )}
    </section>
  );
}
