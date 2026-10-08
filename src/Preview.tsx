import type { Process } from "@wasmer/sdk/browser";
import {
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Settings2,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EsbuildService } from "./preview/esbuild-service.ts";
import {
  defaultPreviewConfig,
  defaultPreviewPort,
  type PreviewConfig,
  readPreviewConfig,
  writePreviewConfig,
} from "./preview-config.ts";
import esbuildShim from "./sandbox/guest/esbuild-shim.js?raw";
import rollupParseAst from "./sandbox/guest/rollup-parse-ast.js?raw";
import viteLauncher from "./sandbox/guest/vite-launcher.mjs?raw";
import { serveScript } from "./sandbox/serve-script.ts";
import type { WasmerSandbox } from "./sandbox/wasmer.ts";
import { wsBridgeScript } from "./sandbox/ws-bridge-script.ts";
import "./preview.css";

export const previewPort = defaultPreviewPort;

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

type Tunnel = { write: (line: string) => Promise<void>; kill: () => Promise<void> };
type TunnelRoute = { source: Window; origin: string; pageId: number };

export function usePreview(sandbox: WasmerSandbox | null, origin: string) {
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [logs, setLogs] = useState("");
  const [error, setError] = useState("");
  const [ports, setPorts] = useState<number[]>([]);
  const [pageErrors, setPageErrors] = useState<string[]>([]);
  const [config, setConfig] = useState<PreviewConfig>(defaultPreviewConfig);
  const pageErrorsRef = useRef<string[]>([]);
  pageErrorsRef.current = pageErrors;
  const logsRef = useRef("");
  logsRef.current = logs;
  const process = useRef<Process | null>(null);
  const closeServer = useRef<(() => Promise<void>) | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const tunnel = useRef<Tunnel | null>(null);
  const routes = useRef(new Map<number, TunnelRoute>());
  const pageIds = useRef(new Map<Window, Map<number, number>>());
  const nextRoute = useRef(1);

  // A dev server that restarts itself (Vite after a config change) closes
  // its listener and binds the port again; the exposure then has to be
  // recreated and the frame reloaded from the new listener.
  const relisten = useRef(false);
  const [frameVersion, setFrameVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: expose only reads refs and the stable origin
  useEffect(() => {
    if (!sandbox) return;
    void readPreviewConfig(sandbox).then(setConfig);
    return sandbox.onListen(
      (port) => {
        setPorts((known) => (known.includes(port) ? known : [...known, port]));
        if (port !== configRef.current.port || !relisten.current || !process.current) return;
        relisten.current = false;
        void (async () => {
          await closeServer.current?.().catch(() => {});
          closeServer.current = null;
          await expose(port).catch(() => {});
          setFrameVersion((version) => version + 1);
        })();
      },
      (port) => {
        setPorts((known) => known.filter((entry) => entry !== port));
        if (port === configRef.current.port && process.current && urlRef.current)
          relisten.current = true;
      },
    );
  }, [sandbox]);

  // The runtime can die mid-session; it rebuilds itself, and the preview
  // server with it is gone until started again.
  useEffect(() => {
    if (!sandbox) return;
    return sandbox.onRestart(() => {
      process.current = null;
      closeServer.current = null;
      tunnel.current = null;
      routes.current.clear();
      pageIds.current.clear();
      setUrl("");
      setRunning(false);
      setPorts([]);
      setError("The sandbox runtime restarted. Start the preview again.");
      setPageErrors((errors) => [
        ...errors,
        "The sandbox runtime was rebuilt: reinstall dependencies (pnpm install) and start the preview again.",
      ]);
    });
  }, [sandbox]);

  /** The bridge process that holds real sockets inside the sandbox. */
  async function ensureTunnel(): Promise<Tunnel | null> {
    if (!sandbox) return null;
    if (tunnel.current) return tunnel.current;
    const started = await sandbox.startPipe(
      "node .sparkbox/ws-bridge.mjs",
      (line) => {
        let message: { op?: string; id?: number } & Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof message.id !== "number") return;
        const route = routes.current.get(message.id);
        if (!route) return;
        route.source.postMessage(
          { ...message, type: "sparkbox:ws", id: route.pageId },
          route.origin,
        );
        if (message.op === "close" || message.op === "error") {
          if (message.op === "close") {
            routes.current.delete(message.id);
            pageIds.current.get(route.source)?.delete(route.pageId);
          }
        }
      },
      () => {
        tunnel.current = null;
        routes.current.clear();
        pageIds.current.clear();
      },
    );
    tunnel.current = started;
    return started;
  }

  // Messages from preview pages: error reports and tunnelled sockets. The
  // listener re-registers when the sandbox changes so the captured tunnel
  // helper can start the bridge process in the current runtime.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tunnel helpers otherwise only read refs
  useEffect(() => {
    if (!origin) return;
    let expected = "";
    try {
      expected = new URL(origin).origin;
    } catch {
      return;
    }
    const listener = (event: MessageEvent) => {
      // `in` on a cross-origin WindowProxy throws; only the origin is checked here.
      if (event.origin !== expected || !event.source) return;
      const data = event.data as {
        type?: string;
        message?: string;
        href?: string;
        probe?: boolean;
        op?: string;
        id?: number;
        path?: string;
        protocols?: string[];
        text?: string;
        base64?: string;
        code?: number;
        reason?: string;
      } | null;
      if (!data) return;
      if (data.type === "sparkbox:page-error" && typeof data.message === "string") {
        // Hidden probe frames belong to the agent's preview tool, not the user's view.
        if (data.probe) return;
        const line = `${data.href && data.href !== "/" ? `${data.href}: ` : ""}${data.message}`;
        setPageErrors((previous) => [...previous.slice(-49), line]);
        return;
      }
      if (data.type !== "sparkbox:ws" || typeof data.id !== "number") return;
      const source = event.source as Window;
      const pageId = data.id;
      void (async () => {
        const pipe = await ensureTunnel().catch(() => null);
        if (!pipe) return;
        let perPage = pageIds.current.get(source);
        if (!perPage) {
          perPage = new Map();
          pageIds.current.set(source, perPage);
        }
        if (data.op === "open") {
          const routeId = nextRoute.current++;
          perPage.set(pageId, routeId);
          routes.current.set(routeId, { source, origin: expected, pageId });
          await pipe.write(
            JSON.stringify({
              op: "open",
              id: routeId,
              port: configRef.current.port,
              path: data.path ?? "/",
              protocols: data.protocols ?? [],
            }),
          );
          return;
        }
        const routeId = perPage.get(pageId);
        if (routeId === undefined) return;
        if (data.op === "send")
          await pipe.write(
            JSON.stringify(
              typeof data.text === "string"
                ? { op: "send", id: routeId, text: data.text }
                : { op: "send", id: routeId, base64: data.base64 ?? "" },
            ),
          );
        else if (data.op === "close")
          await pipe.write(
            JSON.stringify({ op: "close", id: routeId, code: data.code, reason: data.reason }),
          );
      })();
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [origin, sandbox]);

  const urlRef = useRef("");
  urlRef.current = url;
  const configRef = useRef(config);
  configRef.current = config;
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

  /** Start the configured command and expose its port; resolves with the preview URL. */
  function start(): Promise<string> {
    if (startingRef.current) return startingRef.current;
    if (!sandbox) return Promise.reject(new Error("The sandbox is not ready."));
    const run = (async () => {
      setStarting(true);
      setError("");
      setLogs("");
      logsRef.current = "";
      setPageErrors([]);
      try {
        const current = await readPreviewConfig(sandbox);
        setConfig(current);
        configRef.current = current;
        await sandbox.writeFile(".sparkbox/serve.mjs", serveScript);
        await sandbox.writeFile(".sparkbox/ws-bridge.mjs", wsBridgeScript);
        await sandbox.writeFile(".sparkbox/esbuild-shim.js", esbuildShim);
        await sandbox.writeFile(".sparkbox/rollup-parse-ast.js", rollupParseAst);
        await sandbox.writeFile(".sparkbox/vite.mjs", viteLauncher);
        let host = "";
        try {
          host = new URL(origin).hostname;
        } catch {
          host = "";
        }
        // Vite (6.0.9+) accepts the preview hostname through this variable; the
        // rest is the project's own command.
        const env = `SPARKBOX=1 ${host ? `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${host} ` : ""}`;
        // Guest tools (Vite's esbuild replacement) call into the page over stdio.
        let service: EsbuildService | null = null;
        const started = await sandbox.start(
          `${env}${current.command}`,
          (chunk) =>
            setLogs((text) => {
              const next = (text + chunk).slice(-20_000);
              logsRef.current = next;
              return next;
            }),
          (line) => service?.handleLine(line),
        );
        service = new EsbuildService(sandbox, started.write);
        // File changes the page knows about go straight to the dev server.
        const unsubscribe = sandbox.onFilesChanged((event) => {
          void started.write(JSON.stringify({ op: "files", ...event })).catch(() => {});
        });
        process.current = started.process;
        setRunning(true);
        void started.done.then((code) => {
          unsubscribe();
          void service?.dispose();
          if (process.current === started.process) {
            process.current = null;
            setRunning(false);
            if (code !== 0) setError(`The preview server exited with code ${code}.`);
          }
        });
        await sandbox.waitForPort(current.port, 90_000);
        return await expose(current.port);
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
    const pipe = tunnel.current;
    tunnel.current = null;
    routes.current.clear();
    pageIds.current.clear();
    await pipe?.kill().catch(() => {});
    setUrl("");
    urlRef.current = "";
    if (current) await current.kill().catch(() => {});
    setRunning(false);
  }

  async function restart() {
    await stop();
    return start();
  }

  /** Ask the visible page to reload itself. */
  function reload() {
    const target = frame.current?.contentWindow;
    if (!target || !urlRef.current) return;
    let expected = "";
    try {
      expected = new URL(origin).origin;
    } catch {
      return;
    }
    target.postMessage({ type: "sparkbox:reload" }, expected);
  }

  async function configure(next: Partial<PreviewConfig>) {
    if (!sandbox) throw new Error("The sandbox is not ready.");
    const saved = await writePreviewConfig(sandbox, next);
    setConfig(saved);
    configRef.current = saved;
    if (process.current) await restart();
    return saved;
  }

  return {
    url,
    running,
    starting,
    logs,
    error,
    ports,
    config,
    pageErrors,
    /** Stable accessors for the agent's tools. */
    recentPageErrors: () => pageErrorsRef.current,
    frameVersion,
    recentLogs: () => logsRef.current,
    currentConfig: () => configRef.current,
    clearPageErrors: () => setPageErrors([]),
    setFrame: (element: HTMLIFrameElement | null) => {
      frame.current = element;
    },
    start,
    ensureRunning,
    stop,
    restart,
    reload,
    configure,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      {preview.url && (
        <button
          type="button"
          className="button small"
          onClick={preview.reload}
          title="Reload the page"
        >
          <RefreshCw size={14} /> Reload
        </button>
      )}
      {preview.running && (
        <button
          type="button"
          className="button small"
          onClick={() => void preview.restart().catch(() => {})}
          title="Restart the preview server"
        >
          <RotateCcw size={14} /> Restart
        </button>
      )}
      <button
        type="button"
        className="button small"
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen(!settingsOpen)}
        title="Preview command, port and directory"
      >
        <Settings2 size={14} /> Server
      </button>
      {settingsOpen && (
        <form
          className="preview-settings"
          aria-label="Preview server settings"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void preview
              .configure({
                command: String(form.get("command") ?? ""),
                port: Number(form.get("port") ?? previewPort) || previewPort,
                directory: String(form.get("directory") ?? "."),
              })
              .then(() => setSettingsOpen(false))
              .catch(() => {});
          }}
        >
          <label>
            Command
            <input name="command" defaultValue={preview.config.command} autoComplete="off" />
          </label>
          <label>
            Port
            <input
              name="port"
              type="number"
              min={1}
              max={65535}
              defaultValue={preview.config.port}
            />
          </label>
          <label>
            Directory (static server)
            <input name="directory" defaultValue={preview.config.directory} autoComplete="off" />
          </label>
          <p>
            Saved to sparkbox.json in the project. The default serves the project as static files
            with live reload; a Vite project uses its dev server, for example
            <code> npm run dev -- --host 0.0.0.0 --port 5173</code> with port 5173.
          </p>
          <button type="submit" className="button small primary">
            Save and restart
          </button>
        </form>
      )}
      {preview.ports
        .filter((port) => port !== preview.config.port || !preview.url)
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
          key={preview.frameVersion}
          ref={preview.setFrame}
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
