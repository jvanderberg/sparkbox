import { describe, expect, it } from "vitest";
import { applyUpdate, parsePatch, parseUpdateBody } from "../src/agent/apply-patch.ts";

describe("V4A patches", () => {
  it("parses add, delete and update hunks", () => {
    const hunks = parsePatch(`*** Begin Patch
*** Add File: hello.txt
+hello
+world
*** Delete File: old.txt
*** Update File: app.js
*** Move to: src/app.js
@@ function main() {
-  return 1;
+  return 2;
*** End Patch`);
    expect(hunks).toEqual([
      { type: "add", path: "hello.txt", contents: "hello\nworld\n" },
      { type: "delete", path: "old.txt" },
      {
        type: "update",
        path: "app.js",
        movePath: "src/app.js",
        chunks: [
          {
            context: "function main() {",
            oldLines: ["  return 1;"],
            newLines: ["  return 2;"],
            endOfFile: false,
          },
        ],
      },
    ]);
  });

  it("applies an update body with context", () => {
    const original = "function main() {\n  return 1;\n}\n\nfunction other() {\n  return 1;\n}\n";
    const chunks = parseUpdateBody("@@ function other() {\n-  return 1;\n+  return 3;\n");
    expect(applyUpdate(original, chunks)).toBe(
      "function main() {\n  return 1;\n}\n\nfunction other() {\n  return 3;\n}\n",
    );
  });

  it("applies several chunks in order and keeps a missing trailing newline", () => {
    const original = "a\nb\nc\nd";
    const chunks = parseUpdateBody("@@\n a\n-b\n+B\n@@\n-d\n+D\n*** End of File");
    expect(applyUpdate(original, chunks)).toBe("a\nB\nc\nD");
  });

  it("rejects changes whose context is not found", () => {
    expect(() => applyUpdate("x\n", parseUpdateBody("-y\n+z\n"))).toThrow(/Could not find/);
  });
});
