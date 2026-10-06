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

export const sandboxPackages = ["wasmer/bash", "wasmer/edgejs@0.2.5"] as const;

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

/**
 * A Wasmer WASIX sandbox running inside the page. `/workspace` holds the
 * project; it is mirrored to IndexedDB so reloads keep the files.
 */
export class WasmerSandbox implements Sandbox {
  readonly root = "/workspace";
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private processes = new Set<Process>();
  private servers = new Map<number, BrowserServer>();
  private constructor(
    private client: WasmerClient,
    private handle: WasmerSandboxHandle,
    readonly workspace: string,
    readonly restored: boolean,
  ) {}

  static async create(options: WasmerSandboxOptions): Promise<WasmerSandbox> {
    if (!globalThis.crossOriginIsolated)
      throw new Error(
        "This page is not cross-origin isolated. The sandbox needs the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.",
      );
    const { Wasmer } = await import("@wasmer/sdk/browser");
    options.onProgress?.({ phase: "runtime" });
    const client = new Wasmer({ cache: { namespace: "sparkbox" } });
    await client.ready();
    const snapshot = await loadSnapshot(options.workspace);
    const files: Record<string, string | Uint8Array> = snapshot
      ? { ...snapshot.files }
      : { ...(options.template ?? {}) };
    options.onProgress?.({ phase: "resolving" });
    // Edge.js depends on wasmer/bash too, so qualify the shell by package to
    // avoid an ambiguous `bash` selector.
    const bash = await client.packages.load(sandboxPackages[0]);
    const handle = await client.sandboxes.create({
      packages: [bash, sandboxPackages[1]],
      shell: bash.command("bash"),
      files,
      env: {
        HOME: "/workspace",
        PATH: "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.",
        TERM: "xterm-256color",
        CI: "1",
        npm_config_update_notifier: "false",
      },
      network: options.wispUrl ? { mode: "wisp", url: options.wispUrl } : { mode: "http" },
      onPackageProgress: (progress) => {
        options.onProgress?.({
          phase: progress.phase,
          downloadedBytes: progress.download.downloadedBytes,
          totalBytes: progress.download.totalBytes,
          percent: progress.download.percent,
          cached: progress.packages.length > 0 && progress.packages.every((entry) => entry.cached),
        });
      },
    });
    options.onProgress?.({ phase: snapshot ? "restoring" : "ready" });
    options.onProgress?.({ phase: "ready" });
    return new WasmerSandbox(client, handle, options.workspace, Boolean(snapshot));
  }

  private absolute(path: string) {
    return path ? `${this.root}/${path}` : this.root;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const process = await this.handle.shell(command, { cwd: this.root, env: options.env }).spawn({
      stdin: "closed",
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: options.timeoutMs ?? 120_000,
    });
    this.processes.add(process);
    const abort = () => void process.kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const decoder = () => new TextDecoder();
    const collect = async (stream: typeof process.stdout, name: "stdout" | "stderr") => {
      let text = "";
      if (!stream) return text;
      const decode = decoder();
      for await (const chunk of stream) {
        const piece = decode.decode(chunk, { stream: true });
        text += piece;
        options.onOutput?.(piece, name);
      }
      return text;
    };
    try {
      const [stdout, stderr, output] = await Promise.all([
        collect(process.stdout, "stdout"),
        collect(process.stderr, "stderr"),
        process.wait(),
      ]);
      this.changed();
      return {
        stdout,
        stderr,
        exitCode: output.exitCode,
        timedOut: output.reason === "timeout",
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.processes.delete(process);
    }
  }

  readFile(path: string) {
    return this.handle.fs.readFile(this.absolute(path));
  }
  readText(path: string) {
    return this.handle.fs.readText(this.absolute(path));
  }
  async writeFile(path: string, data: Uint8Array | string) {
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (directory) await this.handle.fs.mkdir(this.absolute(directory), { recursive: true });
    await this.handle.fs.writeFile(this.absolute(path), data);
    this.changed();
  }
  async deleteFile(path: string) {
    await this.handle.fs.remove(this.absolute(path), { recursive: true });
    this.changed();
  }
  async exists(path: string) {
    try {
      await this.handle.fs.stat(this.absolute(path));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path: string) {
    await this.handle.fs.mkdir(this.absolute(path), { recursive: true });
    this.changed();
  }
  async listFiles() {
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

  private changed() {
    for (const listener of this.listeners) listener();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persist().catch((error) => console.warn("workspace save failed", error));
    }, 1500);
  }

  /** Start a long-running command (a dev server) and keep it until stopped. */
  async start(
    command: string,
    onOutput: (chunk: string) => void,
  ): Promise<{ process: Process; done: Promise<number> }> {
    const process = await this.handle
      .shell(command, { cwd: this.root })
      .spawn({ stdin: "closed", stdout: "pipe", stderr: "pipe" });
    this.processes.add(process);
    const pump = async (stream: typeof process.stdout) => {
      if (!stream) return;
      const decode = new TextDecoder();
      for await (const chunk of stream) onOutput(decode.decode(chunk, { stream: true }));
    };
    void pump(process.stdout);
    void pump(process.stderr);
    const done = process.wait().then((output) => {
      this.processes.delete(process);
      this.changed();
      return output.exitCode;
    });
    return { process, done };
  }

  /** Resolve once the guest listens on `port`. */
  waitForPort(port: number, timeoutMs = 60_000) {
    return this.handle.ports.wait(port, { timeoutMs });
  }

  /** Watch for guest listeners. */
  onListen(listener: (port: number) => void, onClose?: (port: number) => void) {
    return this.handle.ports.onListen(listener, { onClose });
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

  async close() {
    for (const server of this.servers.values()) await server.close().catch(() => {});
    this.servers.clear();
    for (const process of this.processes) await process.kill().catch(() => {});
    await this.persist().catch(() => {});
    await this.handle.close().catch(() => {});
    await this.client.close().catch(() => {});
  }
}
