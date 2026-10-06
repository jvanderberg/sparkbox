/**
 * The execution environment the agent and the workspace UI operate on. The
 * only implementation today runs a Wasmer sandbox inside the browser page;
 * tests use an in-memory one. Paths are workspace-relative unless noted.
 */
export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Receives output as it is produced, for live tool rows. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
};

export type FileEntry = { path: string; type: "file" | "directory"; size?: number };

export interface Sandbox {
  /** Absolute guest path of the project directory, e.g. `/workspace`. */
  readonly root: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** Every file under `root`, relative, sorted, skipping ignored directories. */
  listFiles(): Promise<string[]>;
  /** Fires after any write made through this interface or by a command. */
  subscribe(listener: () => void): () => void;
  /** Persist now, if the implementation persists at all. */
  flush?(): Promise<void>;
}

export const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  ".pnpm-store",
  ".wasmer",
  ".sparkbox",
  ".npm",
  ".pnpm",
  ".config",
  ".local",
]);

export function isIgnoredPath(path: string) {
  return path.split("/").some((segment) => ignoredDirectories.has(segment));
}

/**
 * Resolve a model-supplied path against the sandbox root. Rejects anything
 * that escapes the root. Returns the path relative to the root.
 */
export function workspacePath(root: string, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("A file path is required.");
  const absolute = trimmed.startsWith("/") ? trimmed : `${root}/${trimmed}`;
  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) throw new Error(`Path escapes the workspace: ${input}`);
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const resolved = `/${segments.join("/")}`;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (resolved !== root && !resolved.startsWith(prefix))
    throw new Error(`Path is outside the workspace: ${input}`);
  return resolved === root ? "" : resolved.slice(prefix.length);
}
