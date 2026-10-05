import { createTwoFilesPatch } from "diff";
import type { Changes } from "./types.ts";

export type FileMap = Record<string, Uint8Array>;

function isBinary(data: Uint8Array) {
  const sample = data.subarray(0, 8000);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

function same(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const decoder = new TextDecoder();

/**
 * Unified diffs between the saved version and the current files, in the same
 * shape Civic Spark's server produced from Git.
 */
export function computeChanges(baseline: FileMap, current: FileMap, base = "saved"): Changes {
  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  const files: Changes["files"] = [];
  for (const path of paths) {
    const before = baseline[path];
    const after = current[path];
    if (before && after && same(before, after)) continue;
    const status = !before ? "added" : !after ? "deleted" : "modified";
    const binary = Boolean((before && isBinary(before)) || (after && isBinary(after)));
    const diff = binary
      ? ""
      : createTwoFilesPatch(
          before ? `a/${path}` : "/dev/null",
          after ? `b/${path}` : "/dev/null",
          before ? decoder.decode(before) : "",
          after ? decoder.decode(after) : "",
          undefined,
          undefined,
          { context: 3 },
        );
    files.push({ path, status, diff, binary });
  }
  return { base, files };
}
