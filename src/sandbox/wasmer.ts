import type {
  BrowserServer,
  Process,
  Wasmer as WasmerClient,
  Sandbox as WasmerSandboxHandle,
} from "@wasmer/sdk/browser";
import { loadSnapshot, saveSnapshot } from "./storage.ts";
import {
  type ExecOptions,
  type ExecResult,
  ignoredDirectories,
  isIgnoredPath,
  type Sandbox,
} from "./types.ts";

/** Prefix of stdout lines that carry requests from guest tools to the page. */
export const rpcMarker = "@@sparkbox-rpc@@";

export const sandboxPackages = [
  "wasmer/bash",
  "wasmer/edgejs@0.2.5",
  "wasmer/grep@3.12.0",
  "wasmer/sed@4.9.0",
  "wasmer/ripgrep@15.2.1",
] as const;

export type SandboxProgress = {
  phase: "runtime" | "resolving" | "downloading" | "loading" | "restoring" | "ready";
  downloadedBytes?: number;
  totalBytes?: number | null;
  percent?: number | null;
  cached?: boolean;
};

export type WasmerSandboxOptions = {
  workspace: string;
  /** Files to create when no snapshot exists for this workspace. */
  template?: Record<string, string | Uint8Array>;
  /** Outbound network relay; without it the sandbox has no internet access. */
  wispUrl?: string;
  onProgress?: (progress: SandboxProgress) => void;
};

export type PreviewServer = { port: number; url: string; close: () => Promise<void> };

/** The SDK's worker pool can die; commands then fail until the sandbox is rebuilt. */
export function isDeadRuntime(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Scheduler is dead|thread pool is shut down|WORKER_FAILED|CLIENT_CLOSED|SANDBOX_CLOSED/i.test(
    message,
  );
}

type Boot = { client: WasmerClient; handle: WasmerSandboxHandle };

/**
 * A Wasmer WASIX sandbox running inside the page. `/workspace` holds the
 * project; it is mirrored to IndexedDB so reloads keep the files.
 */
export class WasmerSandbox implements Sandbox {
  readonly root = "/workspace";
  private listeners = new Set<() => void>();
  private restartListeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private restarting: Promise<void> | null = null;
  private processes = new Set<Process>();
  private servers = new Map<number, BrowserServer>();
  private closed = false;
  private constructor(
    private client: WasmerClient,
    private handle: WasmerSandboxHandle,
    readonly workspace: string,
    readonly restored: boolean,
    private wispUrl: string | undefined,
  ) {}

  static async create(options: WasmerSandboxOptions): Promise<WasmerSandbox> {
    if (!globalThis.crossOriginIsolated)
      throw new Error(
        "This page is not cross-origin isolated. The sandbox needs the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.",
      );
    options.onProgress?.({ phase: "runtime" });
    const snapshot = await loadSnapshot(options.workspace);
    const files: Record<string, string | Uint8Array> = snapshot
      ? { ...snapshot.files }
      : { ...(options.template ?? {}) };
    const boot = await WasmerSandbox.boot(files, options.wispUrl, options.onProgress);
    options.onProgress?.({ phase: snapshot ? "restoring" : "ready" });
    options.onProgress?.({ phase: "ready" });
    return new WasmerSandbox(
      boot.client,
      boot.handle,
      options.workspace,
      Boolean(snapshot),
      options.wispUrl,
    );
  }

  private static async boot(
    files: Record<string, string | Uint8Array>,
    wispUrl: string | undefined,
    onProgress?: (progress: SandboxProgress) => void,
  ): Promise<Boot> {
    const { Wasmer } = await import("@wasmer/sdk/browser");
    const client = new Wasmer({ cache: { namespace: "sparkbox" } });
    await client.ready();
    onProgress?.({ phase: "resolving" });
    // Edge.js depends on wasmer/bash too, so qualify the shell by package to
    // avoid an ambiguous `bash` selector.
    const bash = await client.packages.load(sandboxPackages[0]);
    const handle = await client.sandboxes.create({
      packages: [bash, ...sandboxPackages.slice(1)],
      shell: bash.command("bash"),
      files,
      env: {
        HOME: "/workspace",
        PATH: "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.",
        TERM: "xterm-256color",
        CI: "1",
        npm_config_update_notifier: "false",
      },
      network: wispUrl ? { mode: "wisp", url: wispUrl } : { mode: "http" },
      onPackageProgress: (progress) => {
        onProgress?.({
          phase: progress.phase,
          downloadedBytes: progress.download.downloadedBytes,
          totalBytes: progress.download.totalBytes,
          percent: progress.download.percent,
          cached: progress.packages.length > 0 && progress.packages.every((entry) => entry.cached),
        });
      },
    });
    return { client, handle };
  }

  /** Rebuild the runtime after its worker pool died, keeping the files. */
  async restart() {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      let files: Record<string, Uint8Array> = {};
      try {
        files = await this.snapshot();
      } catch {
        files = (await loadSnapshot(this.workspace))?.files ?? {};
      }
      for (const server of this.servers.values()) await server.close().catch(() => {});
      this.servers.clear();
      this.processes.clear();
      await this.handle.close().catch(() => {});
      await this.client.close().catch(() => {});
      const boot = await WasmerSandbox.boot(files, this.wispUrl);
      this.client = boot.client;
      this.handle = boot.handle;
      for (const listener of this.restartListeners) listener();
      this.changed();
    })().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  /** Called after an automatic restart; preview servers are gone by then. */
  onRestart(listener: () => void) {
    this.restartListeners.add(listener);
    return () => {
      this.restartListeners.delete(listener);
    };
  }

  /** Run `fn`, rebuilding the runtime once if it has died. */
  private async recover<T>(fn: () => Promise<T>): Promise<T> {
    if (this.restarting) await this.restarting;
    try {
      return await fn();
    } catch (error) {
      if (this.closed || !isDeadRuntime(error)) throw error;
      await this.restart();
      return await fn();
    }
  }

  private absolute(path: string) {
    return path ? `${this.root}/${path}` : this.root;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const process = await this.recover(() =>
      this.handle.shell(command, { cwd: this.root, env: options.env }).spawn({
        stdin: "closed",
        stdout: "pipe",
        stderr: "pipe",
        timeoutMs: options.timeoutMs ?? 120_000,
      }),
    );
    this.processes.add(process);
    const abort = () => void process.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const partial = { stdout: "", stderr: "" };
    const collect = async (stream: typeof process.stdout, name: "stdout" | "stderr") => {
      let text = "";
      if (!stream) return text;
      const decode = new TextDecoder();
      for await (const chunk of stream) {
        const piece = decode.decode(chunk, { stream: true });
        text += piece;
        partial[name] = text;
        options.onOutput?.(piece, name);
      }
      return text;
    };
    const outputs = {
      stdout: collect(process.stdout, "stdout"),
      stderr: collect(process.stderr, "stderr"),
    };
    try {
      // Helper processes (pnpm workers, backgrounded servers) can keep the
      // pipes open after the command exits. Collect until exit plus a short
      // grace period instead of waiting for end of stream.
      const output = await process.wait();
      // Output can still be in flight after exit; stop once both streams end or
      // nothing new has arrived for a moment (bounded at two seconds).
      const deadline = Date.now() + 2000;
      let seen = partial.stdout.length + partial.stderr.length;
      let idleSince = Date.now();
      const ended = Promise.all([outputs.stdout, outputs.stderr]).then(() => true);
      while (Date.now() < deadline) {
        const done = await Promise.race([
          ended,
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
        ]);
        if (done) break;
        const now = partial.stdout.length + partial.stderr.length;
        if (now !== seen) {
          seen = now;
          idleSince = Date.now();
        } else if (Date.now() - idleSince > 500) break;
      }
      this.changed();
      return {
        stdout: partial.stdout,
        stderr: partial.stderr,
        exitCode: output.exitCode,
        timedOut: output.reason === "timeout",
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.processes.delete(process);
    }
  }

  readFile(path: string) {
    return this.recover(() => this.handle.fs.readFile(this.absolute(path)));
  }
  readText(path: string) {
    return this.recover(() => this.handle.fs.readText(this.absolute(path)));
  }
  async writeFile(path: string, data: Uint8Array | string) {
    await this.recover(async () => {
      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (directory) await this.handle.fs.mkdir(this.absolute(directory), { recursive: true });
      await this.handle.fs.writeFile(this.absolute(path), data);
    });
    this.changed();
  }
  async deleteFile(path: string) {
    await this.recover(() => this.handle.fs.remove(this.absolute(path), { recursive: true }));
    this.changed();
  }
  async exists(path: string) {
    return (await this.stat(path)) !== null;
  }
  /** File kind and size, or null when nothing is at `path`. */
  async stat(path: string): Promise<{ kind: "file" | "directory"; size: number } | null> {
    try {
      const result = await this.recover(() => this.handle.fs.stat(this.absolute(path)));
      return { kind: result.kind, size: result.size };
    } catch {
      return null;
    }
  }
  async mkdir(path: string) {
    await this.recover(() => this.handle.fs.mkdir(this.absolute(path), { recursive: true }));
    this.changed();
  }
  listFiles() {
    return this.recover(async () => {
      const files: string[] = [];
      const walk = async (relative: string) => {
        const entries = await this.handle.fs.readDir(this.absolute(relative));
        for (const entry of entries) {
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.kind === "directory") {
            if (!ignoredDirectories.has(entry.name)) await walk(path);
          } else files.push(path);
        }
      };
      await walk("");
      return files.sort();
    });
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Everything under the workspace except ignored directories, for persistence. */
  async snapshot(): Promise<Record<string, Uint8Array>> {
    const files: Record<string, Uint8Array> = {};
    for (const path of await this.listFiles())
      if (!isIgnoredPath(path)) files[path] = await this.readFile(path);
    return files;
  }

  /** Persist now, waiting for any in-flight save first. */
  async persist() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saving) await this.saving;
    this.saving = saveSnapshot(this.workspace, await this.snapshot()).finally(() => {
      this.saving = null;
    });
    await this.saving;
  }
  flush() {
    return this.persist();
  }

  private changed() {
    for (const listener of this.listeners) listener();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persist().catch((error) => console.warn("workspace save failed", error));
    }, 1500);
  }

  /** Start a long-running command (a dev server) and keep it until stopped. */
  /**
   * Start a long-running command with stdin open. Stdout lines that carry
   * the RPC marker go to `onRpc` (without the marker); everything else is
   * output. The page answers RPC requests by writing lines to stdin.
   */
  async start(
    command: string,
    onOutput: (chunk: string) => void,
    onRpc?: (line: string) => void,
  ): Promise<{ process: Process; done: Promise<number>; write: (line: string) => Promise<void> }> {
    const process = await this.recover(() =>
      this.handle
        .shell(command, { cwd: this.root })
        .spawn({ stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
    );
    this.processes.add(process);
    const pumpStderr = async () => {
      if (!process.stderr) return;
      const decode = new TextDecoder();
      for await (const chunk of process.stderr) onOutput(decode.decode(chunk, { stream: true }));
    };
    const pumpStdout = async () => {
      if (!process.stdout) return;
      const decode = new TextDecoder();
      let buffer = "";
      for await (const chunk of process.stdout) {
        buffer += decode.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.startsWith(rpcMarker)) onRpc?.(line.slice(rpcMarker.length));
          else onOutput(`${line}\n`);
          newline = buffer.indexOf("\n");
        }
        // Partial lines stream through unless they could be the start of an RPC line.
        if (buffer && !rpcMarker.startsWith(buffer) && !buffer.startsWith(rpcMarker)) {
          onOutput(buffer);
          buffer = "";
        }
      }
      if (buffer && !buffer.startsWith(rpcMarker)) onOutput(buffer);
    };
    void pumpStdout();
    void pumpStderr();
    const done = process.wait().then((output) => {
      this.processes.delete(process);
      this.changed();
      return output.exitCode;
    });
    return {
      process,
      done,
      write: async (line: string) => {
        await process.stdin?.write(`${line}\n`);
      },
    };
  }

  /**
   * Start a line-oriented helper process with stdin open. Used for the
   * WebSocket bridge: JSON lines in, JSON lines out.
   */
  async startPipe(
    command: string,
    onLine: (line: string) => void,
    onExit?: (code: number) => void,
  ): Promise<{ write: (line: string) => Promise<void>; kill: () => Promise<void> }> {
    const process = await this.recover(() =>
      this.handle
        .shell(command, { cwd: this.root })
        .spawn({ stdin: "pipe", stdout: "pipe", stderr: "discard" }),
    );
    this.processes.add(process);
    void (async () => {
      if (!process.stdout) return;
      for await (const line of process.stdout.lines()) onLine(line);
    })();
    void process.wait().then((output) => {
      this.processes.delete(process);
      onExit?.(output.exitCode);
    });
    return {
      write: async (line: string) => {
        await process.stdin?.write(`${line}\n`);
      },
      kill: async () => {
        await process.kill().catch(() => {});
      },
    };
  }

  /** Resolve once the guest listens on `port`. */
  waitForPort(port: number, timeoutMs = 60_000) {
    return this.handle.ports.wait(port, { timeoutMs });
  }

  /** Watch for guest listeners. Re-attached automatically after a restart. */
  onListen(listener: (port: number) => void, onClose?: (port: number) => void) {
    let detach = this.handle.ports.onListen(listener, { onClose });
    const reattach = () => {
      detach = this.handle.ports.onListen(listener, { onClose });
    };
    this.restartListeners.add(reattach);
    return () => {
      detach();
      this.restartListeners.delete(reattach);
    };
  }

  /** Expose a guest port through the preview host origin. */
  async expose(port: number, serviceWorkerOrigin: string): Promise<PreviewServer> {
    const existing = this.servers.get(port);
    if (existing) return { port, url: existing.url.href, close: () => this.closeServer(port) };
    const server = await this.handle.ports.expose(port, { serviceWorker: serviceWorkerOrigin });
    this.servers.set(port, server);
    return { port, url: server.url.href, close: () => this.closeServer(port) };
  }

  private async closeServer(port: number) {
    const server = this.servers.get(port);
    this.servers.delete(port);
    await server?.close();
  }

  /**
   * Shut down. `persist` is false when this instance never became the live
   * one (React StrictMode mounts twice), so a stale copy never overwrites
   * the files the live instance is still editing.
   */
  async close({ persist = true } = {}) {
    this.closed = true;
    for (const server of this.servers.values()) await server.close().catch(() => {});
    this.servers.clear();
    for (const process of this.processes) await process.kill().catch(() => {});
    if (persist) await this.persist().catch(() => {});
    await this.handle.close().catch(() => {});
    await this.client.close().catch(() => {});
  }
}
