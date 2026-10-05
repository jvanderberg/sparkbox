/**
 * Workspace persistence. The Wasmer sandbox filesystem lives in memory, so the
 * project files are mirrored into IndexedDB after every change and replayed
 * when the sandbox is recreated. Dependencies and build output are not kept.
 */
import { isIgnoredPath } from "./types.ts";

const dbName = "sparkbox";
const stores = ["workspaces", "sessions", "transcripts"] as const;
type Store = (typeof stores)[number];

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 2);
    request.onupgradeneeded = () => {
      for (const store of stores)
        if (!request.result.objectStoreNames.contains(store))
          request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable"));
  });
}

function transact<T>(
  mode: IDBTransactionMode,
  run: (objects: IDBObjectStore) => IDBRequest<T>,
  store: Store = "workspaces",
) {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = run(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        tx.oncomplete = () => db.close();
      }),
  );
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

export async function saveSnapshot(workspace: string, files: Record<string, Uint8Array>) {
  const kept: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(files)) if (!isIgnoredPath(path)) kept[path] = data;
  await transact("readwrite", (objects) =>
    objects.put({ files: kept, savedAt: new Date().toISOString() }, workspace),
  );
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
