import type { Process } from "@wasmer/sdk/browser";
import { ExternalLink, Play, ScrollText, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { serveScript } from "./sandbox/serve-script.ts";
import type { WasmerSandbox } from "./sandbox/wasmer.ts";
import "./preview.css";

export const previewPort = 8080;

/** Where the preview iframe loads from. Must be a different origin than the app. */
export function defaultPreviewOrigin() {
  const { protocol, hostname, port } = location;
  const suffix = port ? `:${port}` : "";
  if (hostname === "127.0.0.1") return `${protocol}//localhost${suffix}`;
  if (hostname === "localhost") return `${protocol}//127.0.0.1${suffix}`;
  return "";
}

export function usePreview(sandbox: WasmerSandbox | null, origin: string) {
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [logs, setLogs] = useState("");
  const [error, setError] = useState("");
  const [ports, setPorts] = useState<number[]>([]);
  const process = useRef<Process | null>(null);
  const closeServer = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!sandbox) return;
    return sandbox.onListen(
      (port) => setPorts((known) => (known.includes(port) ? known : [...known, port])),
      (port) => setPorts((known) => known.filter((entry) => entry !== port)),
    );
  }, [sandbox]);

  async function expose(port: number) {
    if (!sandbox) return;
    if (!origin) {
      setError(
        "Set a preview origin in Settings. The preview needs a second origin to serve from.",
      );
      return;
    }
    try {
      const server = await sandbox.expose(port, origin);
      closeServer.current = server.close;
      setUrl(server.url);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function start() {
    if (!sandbox || starting) return;
    setStarting(true);
    setError("");
    setLogs("");
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
      await expose(previewPort);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
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

  return { url, running, starting, logs, error, ports, start, stop, expose };
}

export function PreviewControls({
  preview,
  disabled,
  onShow,
}: {
  preview: ReturnType<typeof usePreview>;
  disabled: boolean;
  /** Called when a preview is started or exposed, so the panel can be shown. */
  onShow: () => void;
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
            void preview.start();
          }}
          disabled={disabled || preview.starting}
        >
          <Play size={14} /> {preview.starting ? "Starting…" : "Preview"}
        </button>
      )}
      {preview.url && (
        <a className="button small" href={preview.url} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> Open
        </a>
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
              void preview.expose(port);
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
        </pre>
      )}
    </div>
  );
}

export function PreviewPanel({
  preview,
  visible,
}: {
  preview: ReturnType<typeof usePreview>;
  visible: boolean;
}) {
  return (
    <section className="workspace-panel preview-panel" aria-label="Preview" hidden={!visible}>
      {preview.error && (
        <p className="preview-error" role="alert">
          {preview.error}
        </p>
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
            onClick={() => void preview.start()}
            disabled={preview.starting || preview.running}
          >
            <Play size={14} /> {preview.starting ? "Starting…" : "Preview"}
          </button>
        </div>
      )}
    </section>
  );
}
