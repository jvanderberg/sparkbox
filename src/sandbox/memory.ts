import { type ExecOptions, type ExecResult, isIgnoredPath, type Sandbox } from "./types.ts";

/** In-memory sandbox for tests. `exec` is a stub unless a handler is supplied. */
export class MemorySandbox implements Sandbox {
  readonly root = "/workspace";
  private files = new Map<string, Uint8Array>();
  private listeners = new Set<() => void>();
  constructor(
    initial: Record<string, string> = {},
    private handler: (
      command: string,
      options?: ExecOptions,
    ) => Promise<ExecResult> = async () => ({
      stdout: "",
      stderr: "exec is not available in the memory sandbox",
      exitCode: 127,
      timedOut: false,
    }),
  ) {
    for (const [path, content] of Object.entries(initial))
      this.files.set(path, new TextEncoder().encode(content));
  }
  exec(command: string, options?: ExecOptions) {
    return this.handler(command, options);
  }
  async readFile(path: string) {
    const data = this.files.get(path);
    if (!data) throw new Error(`No such file: ${path}`);
    return data;
  }
  async readText(path: string) {
    return new TextDecoder().decode(await this.readFile(path));
  }
  async writeFile(path: string, data: Uint8Array | string) {
    this.files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    this.notify();
  }
  async deleteFile(path: string) {
    if (!this.files.delete(path)) throw new Error(`No such file: ${path}`);
    this.notify();
  }
  async exists(path: string) {
    return this.files.has(path) || [...this.files.keys()].some((p) => p.startsWith(`${path}/`));
  }
  async mkdir() {}
  async stat(path: string): Promise<{ kind: "file" | "directory"; size: number } | null> {
    const file = this.files.get(path);
    if (file) return { kind: "file", size: file.byteLength };
    if (!path || [...this.files.keys()].some((p) => p.startsWith(`${path}/`)))
      return { kind: "directory", size: 0 };
    return null;
  }
  async readDir(path: string): Promise<{ name: string; kind: "file" | "directory" }[]> {
    const prefix = path ? `${path}/` : "";
    const seen = new Map<string, "file" | "directory">();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const name = rest.split("/")[0] ?? "";
      if (name) seen.set(name, rest.includes("/") ? "directory" : "file");
    }
    return [...seen].map(([name, kind]) => ({ name, kind }));
  }
  async listFiles() {
    return [...this.files.keys()].filter((path) => !isIgnoredPath(path)).sort();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  notify() {
    for (const listener of this.listeners) listener();
  }
}
