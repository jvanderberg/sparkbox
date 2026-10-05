import { describe, expect, it } from "vitest";
import { computeChanges } from "../src/workspace/changes.ts";

const text = (value: string) => new TextEncoder().encode(value);

describe("computeChanges", () => {
  it("reports added, modified and deleted files with unified diffs", () => {
    const changes = computeChanges(
      { "keep.txt": text("same\n"), "old.txt": text("gone\n"), "edit.txt": text("a\nb\n") },
      { "keep.txt": text("same\n"), "new.txt": text("fresh\n"), "edit.txt": text("a\nc\n") },
    );
    expect(changes.files.map((file) => [file.path, file.status])).toEqual([
      ["edit.txt", "modified"],
      ["new.txt", "added"],
      ["old.txt", "deleted"],
    ]);
    expect(changes.files[0]?.diff).toContain("-b\n+c");
    expect(changes.files.every((file) => !file.binary)).toBe(true);
  });
  it("marks binary files", () => {
    const changes = computeChanges({}, { "img.png": new Uint8Array([137, 80, 0, 1]) });
    expect(changes.files[0]?.binary).toBe(true);
  });
});
