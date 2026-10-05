import { describe, expect, it } from "vitest";
import { applyPatchOperation, runGenericTool, textEditor } from "../src/agent/tools.ts";
import { MemorySandbox } from "../src/sandbox/memory.ts";
import { workspacePath } from "../src/sandbox/types.ts";

describe("workspacePath", () => {
  it("keeps paths inside the workspace", () => {
    expect(workspacePath("/workspace", "src/app.js")).toBe("src/app.js");
    expect(workspacePath("/workspace", "/workspace/src/../index.html")).toBe("index.html");
    expect(workspacePath("/workspace", "/workspace")).toBe("");
  });
  it("rejects escapes", () => {
    expect(() => workspacePath("/workspace", "../etc/passwd")).toThrow(/outside|escapes/);
    expect(() => workspacePath("/workspace", "/etc/passwd")).toThrow(/outside/);
    expect(() => workspacePath("/workspace", "/workspace2/x")).toThrow(/outside/);
  });
});

describe("text editor tool", () => {
  it("views, creates, replaces and inserts", async () => {
    const sandbox = new MemorySandbox({ "index.html": "<h1>Hi</h1>\n<p>one</p>\n" });
    const view = await textEditor(sandbox, { command: "view", path: "index.html" });
    expect(view.output).toContain("     1\t<h1>Hi</h1>");
    await textEditor(sandbox, { command: "create", path: "src/a.js", file_text: "let a = 1;\n" });
    expect(await sandbox.readText("src/a.js")).toBe("let a = 1;\n");
    const replaced = await textEditor(sandbox, {
      command: "str_replace",
      path: "index.html",
      old_str: "<p>one</p>",
      new_str: "<p>two</p>",
    });
    expect(replaced.error).toBeUndefined();
    expect(await sandbox.readText("index.html")).toBe("<h1>Hi</h1>\n<p>two</p>\n");
    const ambiguous = await textEditor(sandbox, {
      command: "str_replace",
      path: "index.html",
      old_str: "<",
      new_str: "[",
    });
    expect(ambiguous.error).toBe(true);
    await textEditor(sandbox, {
      command: "insert",
      path: "index.html",
      insert_line: 1,
      insert_text: "<!-- note -->\n",
    });
    expect(await sandbox.readText("index.html")).toBe("<h1>Hi</h1>\n<!-- note -->\n<p>two</p>\n");
    const listing = await textEditor(sandbox, { command: "view", path: "." });
    expect(listing.output.split("\n")).toEqual(["index.html", "src/a.js"]);
  });
});

describe("apply_patch operations", () => {
  it("creates, updates and deletes files", async () => {
    const sandbox = new MemorySandbox({ "a.txt": "one\ntwo\nthree\n" });
    await applyPatchOperation(sandbox, { type: "create_file", path: "b.txt", diff: "+b1\n+b2\n" });
    expect(await sandbox.readText("b.txt")).toBe("b1\nb2\n");
    const updated = await applyPatchOperation(sandbox, {
      type: "update_file",
      path: "a.txt",
      diff: "@@\n one\n-two\n+2\n three\n",
    });
    expect(updated.error).toBeUndefined();
    expect(await sandbox.readText("a.txt")).toBe("one\n2\nthree\n");
    const failed = await applyPatchOperation(sandbox, {
      type: "update_file",
      path: "a.txt",
      diff: "-missing\n+x\n",
    });
    expect(failed.error).toBe(true);
    await applyPatchOperation(sandbox, { type: "delete_file", path: "b.txt" });
    expect(await sandbox.exists("b.txt")).toBe(false);
  });
});

describe("generic tools", () => {
  it("runs commands through the sandbox and edits files", async () => {
    const sandbox = new MemorySandbox({ "x.txt": "hello\n" }, async (command) => ({
      stdout: `ran ${command}`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));
    const ran = await runGenericTool(sandbox, "run_command", { command: "ls" });
    expect(ran.output).toBe("ran ls");
    await runGenericTool(sandbox, "edit_file", {
      path: "x.txt",
      old_text: "hello",
      new_text: "bye",
    });
    expect(await sandbox.readText("x.txt")).toBe("bye\n");
    const unknown = await runGenericTool(sandbox, "nope", {});
    expect(unknown.error).toBe(true);
  });
});
