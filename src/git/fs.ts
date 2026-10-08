/**
 * The filesystem isomorphic-git runs on. Two halves behind one interface:
 * the git directory is an in-memory store (persisted to IndexedDB by the
 * owner), so object reads never cross into the sandbox worker, and the
 * working tree is the sandbox's workspace, read and written through the
 * page's sandbox adapter so its mirror and listeners stay right.
 */
import { ignoredDirectories } from "../sandbox/types.ts";

/** What the working tree has to offer. The sandbox adapters implement it. */
export interface Worktree {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  stat(path: string): Promise<{ kind: "file" | "directory"; size: number } | null>;
  readDir(path: string): Promise<{ name: string; kind: "file" | "directory" }[]>;
}

export const workDir = "/work";
export const gitDir = "/git";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FsError extends Error {
  constructor(
    readonly code: "ENOENT" | "EEXIST" | "ENOTDIR" | "ENOTEMPTY",
    path: string,
  ) {
    super(`${code}: ${path}`);
  }
}

type Stats = {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
};

function stats(type: "file" | "dir", size: number, mtimeMs: number): Stats {
  return {
    type,
    mode: type === "dir" ? 0o40000 : 0o100644,
    size,
    ino: 0,
    mtimeMs,
    ctimeMs: mtimeMs,
    uid: 0,
    gid: 0,
    dev: 0,
    isFile: () => type === "file",
    isDirectory: () => type === "dir",
    isSymbolicLink: () => false,
  };
}

/** The git directory: files by path, plus the directories that exist. */
export class GitStore {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>([""]);
  private times = new Map<string, number>();
  /** Set by every write; the owner clears it after persisting. */
  dirty = false;

  constructor(initial: Record<string, Uint8Array> = {}) {
    for (const [path, data] of Object.entries(initial)) this.set(path, data);
    this.dirty = false;
  }

  private parentsOf(path: string) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }

  get(path: string) {
    return this.files.get(path);
  }
  set(path: string, data: Uint8Array) {
    this.parentsOf(path);
    this.files.set(path, data);
    this.times.set(path, Date.now());
    this.dirty = true;
  }
  delete(path: string) {
    const existed = this.files.delete(path);
    this.times.delete(path);
    if (existed) this.dirty = true;
    return existed;
  }
  hasDir(path: string) {
    return this.dirs.has(path);
  }
  mkdir(path: string) {
    this.parentsOf(`${path}/x`);
    this.dirty = true;
  }
  rmdir(path: string) {
    this.dirs.delete(path);
    this.dirty = true;
  }
  children(path: string) {
    const prefix = path ? `${path}/` : "";
    const names = new Set<string>();
    for (const file of this.files.keys())
      if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0] ?? "");
    for (const dir of this.dirs)
      if (dir?.startsWith(prefix)) names.add(dir.slice(prefix.length).split("/")[0] ?? "");
    names.delete("");
    return [...names].sort();
  }
  time(path: string) {
    return this.times.get(path) ?? 0;
  }
  isEmpty() {
    return this.files.size === 0;
  }
  /** Everything, for persistence. */
  toRecord(): Record<string, Uint8Array> {
    return Object.fromEntries(this.files);
  }
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("Unsupported data for writeFile");
}

/**
 * Build the fs client. Worktree stats carry a fresh mtime on every call so
 * isomorphic-git never trusts its index cache and always rehashes files:
 * slower, but a same-size edit can never be missed.
 */
export function createGitFs(worktree: Worktree, store: GitStore) {
  let tick = Date.now();
  const where = (raw: string): { git: string } | { work: string } => {
    // isomorphic-git joins "." and "" segments into its paths.
    const parts = raw.split("/").filter((part) => part && part !== ".");
    const path = `/${parts.join("/")}`;
    if (path === gitDir || path.startsWith(`${gitDir}/`))
      return { git: path.slice(gitDir.length + 1) };
    if (path === workDir || path.startsWith(`${workDir}/`))
      return { work: path.slice(workDir.length + 1) };
    throw new FsError("ENOENT", raw);
  };
  const promises = {
    async readFile(path: string, options?: { encoding?: string } | string) {
      const target = where(path);
      let data: Uint8Array;
      if ("git" in target) {
        const found = store.get(target.git);
        if (!found) throw new FsError("ENOENT", path);
        data = found;
      } else {
        try {
          data = await worktree.readFile(target.work);
        } catch {
          throw new FsError("ENOENT", path);
        }
      }
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? decoder.decode(data) : data;
    },
    async writeFile(path: string, data: unknown) {
      const target = where(path);
      const bytes = toBytes(data);
      if ("git" in target) store.set(target.git, bytes);
      else await worktree.writeFile(target.work, bytes);
    },
    async unlink(path: string) {
      const target = where(path);
      if ("git" in target) {
        if (!store.delete(target.git)) throw new FsError("ENOENT", path);
        return;
      }
      if (!(await worktree.stat(target.work))) throw new FsError("ENOENT", path);
      await worktree.deleteFile(target.work);
    },
    async readdir(path: string) {
      const target = where(path);
      if ("git" in target) {
        if (!store.hasDir(target.git)) throw new FsError("ENOENT", path);
        return store.children(target.git);
      }
      const entry = await worktree.stat(target.work);
      if (!entry) throw new FsError("ENOENT", path);
      if (entry.kind !== "directory") throw new FsError("ENOTDIR", path);
      // Dependencies, build output and Sparkbox's own files are never git's business.
      return (await worktree.readDir(target.work))
        .filter((child) => !ignoredDirectories.has(child.name))
        .map((child) => child.name)
        .sort();
    },
    async mkdir(path: string) {
      const target = where(path);
      if ("git" in target) {
        if (store.hasDir(target.git)) throw new FsError("EEXIST", path);
        store.mkdir(target.git);
      }
      // Working tree directories appear when a file is written into them.
    },
    async rmdir(path: string) {
      const target = where(path);
      if ("git" in target) {
        if (store.children(target.git).length) throw new FsError("ENOTEMPTY", path);
        store.rmdir(target.git);
        return;
      }
      const entry = await worktree.stat(target.work);
      if (!entry) throw new FsError("ENOENT", path);
      if ((await worktree.readDir(target.work)).length) throw new FsError("ENOTEMPTY", path);
      await worktree.deleteFile(target.work);
    },
    async stat(path: string): Promise<Stats> {
      const target = where(path);
      if ("git" in target) {
        const data = store.get(target.git);
        if (data) return stats("file", data.byteLength, store.time(target.git));
        if (store.hasDir(target.git)) return stats("dir", 0, 0);
        throw new FsError("ENOENT", path);
      }
      const entry = await worktree.stat(target.work);
      if (!entry) throw new FsError("ENOENT", path);
      tick += 1000;
      return stats(entry.kind === "directory" ? "dir" : "file", entry.size, tick);
    },
    async lstat(path: string) {
      return promises.stat(path);
    },
    async readlink(path: string): Promise<never> {
      throw new FsError("ENOENT", path);
    },
    async symlink(_target: string, path: string): Promise<never> {
      throw new FsError("EEXIST", path);
    },
    async chmod() {},
  };
  return { promises };
}
