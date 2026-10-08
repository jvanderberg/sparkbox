/**
 * Workspace persistence. The Wasmer sandbox filesystem lives in memory, so the
 * project files are mirrored into IndexedDB after every change and replayed
 * when the sandbox is recreated. Dependencies and build output are not kept.
 *
 * One connection stays open for the life of the page so that a save can be
 * issued synchronously while the page is being hidden or unloaded; nothing
 * asynchronous runs after those events.
 */
import { isIgnoredPath } from "./types.ts";

const dbName = "sparkbox";
const stores = ["workspaces", "sessions", "transcripts"] as const;
type Store = (typeof stores)[number];

let opening: Promise<IDBDatabase> | null = null;
let connection: IDBDatabase | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 2);
    request.onupgradeneeded = () => {
      for (const store of stores)
        if (!request.result.objectStoreNames.contains(store))
          request.result.createObjectStore(store);
    };
    request.onsuccess = () => {
      const db = request.result;
      const forget = () => {
        if (connection === db) connection = null;
        if (opening) opening = null;
      };
      // Another tab upgrading the schema, or the browser closing the
      // connection: let go and reopen on the next call.
      db.onversionchange = () => {
        forget();
        db.close();
      };
      db.onclose = forget;
      connection = db;
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error("IndexedDB is unavailable"));
    };
  });
  return opening;
}

/** Run one request in its own transaction and resolve when it has committed. */
function perform<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (objects: IDBObjectStore) => IDBRequest<T>,
  store: Store,
) {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = run(tx.objectStore(store));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error("IndexedDB request failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    if (mode === "readwrite") tx.commit?.();
  });
}

function transact<T>(
  mode: IDBTransactionMode,
  run: (objects: IDBObjectStore) => IDBRequest<T>,
  store: Store = "workspaces",
) {
  return open().then((db) => perform(db, mode, run, store));
}

/** Small key/value helpers for agent state. */
export const kv = {
  async get<T>(store: Exclude<Store, "workspaces">, key: string): Promise<T | null> {
    try {
      const value = await transact<T | undefined>("readonly", (objects) => objects.get(key), store);
      return value ?? null;
    } catch {
      return null;
    }
  },
  async set(store: Exclude<Store, "workspaces">, key: string, value: unknown) {
    try {
      await transact("readwrite", (objects) => objects.put(value, key), store);
    } catch {
      // Agent state persistence is best effort; the live session is unaffected.
    }
  },
  async delete(store: Exclude<Store, "workspaces">, key: string) {
    try {
      await transact("readwrite", (objects) => objects.delete(key), store);
    } catch {
      // See set().
    }
  },
};

export type WorkspaceSnapshot = { files: Record<string, Uint8Array>; savedAt: string };

export async function loadSnapshot(workspace: string): Promise<WorkspaceSnapshot | null> {
  try {
    const value = await transact<WorkspaceSnapshot | undefined>("readonly", (objects) =>
      objects.get(workspace),
    );
    return value ?? null;
  } catch {
    return null;
  }
}

function snapshotRecord(files: Record<string, Uint8Array>): WorkspaceSnapshot {
  const kept: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(files)) if (!isIgnoredPath(path)) kept[path] = data;
  return { files: kept, savedAt: new Date().toISOString() };
}

export async function saveSnapshot(workspace: string, files: Record<string, Uint8Array>) {
  const record = snapshotRecord(files);
  await transact("readwrite", (objects) => objects.put(record, workspace));
}

/**
 * Save without waiting for anything: the write is issued on the open
 * connection before this returns, so it survives a page unload. Returns the
 * commit promise, or null when no connection is open yet (the caller should
 * then fall back to `saveSnapshot`).
 */
export function saveSnapshotNow(
  workspace: string,
  files: Record<string, Uint8Array>,
): Promise<void> | null {
  if (!connection) return null;
  const record = snapshotRecord(files);
  try {
    return perform(
      connection,
      "readwrite",
      (objects) => objects.put(record, workspace),
      "workspaces",
    ).then(() => undefined);
  } catch {
    // The connection closed under us; reopen next time.
    connection = null;
    opening = null;
    return null;
  }
}

export async function deleteSnapshot(workspace: string) {
  await transact("readwrite", (objects) => objects.delete(workspace));
}

export async function listSnapshots(): Promise<string[]> {
  try {
    const keys = await transact<IDBValidKey[]>("readonly", (objects) => objects.getAllKeys());
    return keys.map(String).filter((key) => !key.includes("#"));
  } catch {
    return [];
  }
}

/** The files recorded by the last Save version, for the Changes view. */
export function loadBaseline(workspace: string) {
  return loadSnapshot(`${workspace}#baseline`);
}
export function saveBaseline(workspace: string, files: Record<string, Uint8Array>) {
  return saveSnapshot(`${workspace}#baseline`, files);
}
