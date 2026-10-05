import { type Sandbox, workspacePath } from "../sandbox/types.ts";
import { applyUpdate, parseUpdateBody } from "./apply-patch.ts";

export const outputLimit = 16_000;

export function truncate(text: string, limit = outputLimit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.25));
  return `${head}\n… [${text.length - head.length - tail.length} characters omitted] …\n${tail}`;
}

/** Anthropic `text_editor_20250728` commands over a sandbox. */
export async function textEditor(
  sandbox: Sandbox,
  input: Record<string, unknown>,
): Promise<{ output: string; error?: boolean }> {
  const command = String(input.command ?? "");
  const relative = workspacePath(sandbox.root, String(input.path ?? ""));
  const display = relative || ".";
  switch (command) {
    case "view": {
      if (!relative || (await isDirectory(sandbox, relative))) {
        const entries = (await sandbox.listFiles()).filter(
          (path) => !relative || path.startsWith(`${relative}/`),
        );
        return { output: entries.length ? entries.join("\n") : "(empty directory)" };
      }
      if (!(await sandbox.exists(relative)))
        return { output: `File not found: ${display}`, error: true };
      const text = await sandbox.readText(relative);
      const lines = text.split("\n");
      const range = Array.isArray(input.view_range) ? (input.view_range as number[]) : null;
      const start = range?.[0] ? Math.max(1, range[0]) : 1;
      const end = range?.[1] && range[1] !== -1 ? Math.min(lines.length, range[1]) : lines.length;
      const numbered = lines
        .slice(start - 1, end)
        .map((line, index) => `${String(start + index).padStart(6)}\t${line}`)
        .join("\n");
      return { output: truncate(numbered) };
    }
    case "create": {
      const content = String(input.file_text ?? "");
      await sandbox.writeFile(relative, content);
      return { output: `Created ${display}` };
    }
    case "str_replace": {
      if (!(await sandbox.exists(relative)))
        return { output: `File not found: ${display}`, error: true };
      const text = await sandbox.readText(relative);
      const oldText = String(input.old_str ?? "");
      const newText = String(input.new_str ?? "");
      const count = text.split(oldText).length - 1;
      if (count === 0) return { output: `old_str was not found in ${display}.`, error: true };
      if (count > 1)
        return {
          output: `old_str appears ${count} times in ${display}; include more context.`,
          error: true,
        };
      await sandbox.writeFile(
        relative,
        text.replace(oldText, () => newText),
      );
      return { output: `Edited ${display}` };
    }
    case "insert": {
      if (!(await sandbox.exists(relative)))
        return { output: `File not found: ${display}`, error: true };
      const text = await sandbox.readText(relative);
      const lines = text.split("\n");
      const at = Math.max(0, Math.min(lines.length, Number(input.insert_line ?? 0)));
      const insert = String(input.insert_text ?? "")
        .replace(/\n$/, "")
        .split("\n");
      lines.splice(at, 0, ...insert);
      await sandbox.writeFile(relative, lines.join("\n"));
      return { output: `Inserted into ${display}` };
    }
    default:
      return { output: `Unknown editor command: ${command}`, error: true };
  }
}

async function isDirectory(sandbox: Sandbox, relative: string) {
  if (await sandbox.exists(relative)) {
    const files = await sandbox.listFiles();
    return !files.includes(relative) && files.some((path) => path.startsWith(`${relative}/`));
  }
  return false;
}

/** Shell execution shared by every provider. */
export async function runShell(
  sandbox: Sandbox,
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal; onOutput?: (chunk: string) => void } = {},
) {
  const result = await sandbox.exec(command, {
    timeoutMs: options.timeoutMs ?? 120_000,
    signal: options.signal,
    onOutput: options.onOutput ? (chunk) => options.onOutput?.(chunk) : undefined,
  });
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const suffix = result.timedOut
    ? "\n[command timed out]"
    : result.exitCode !== 0
      ? `\n[exit code ${result.exitCode}]`
      : "";
  return { ...result, output: truncate(text) + suffix };
}

/** OpenAI `apply_patch` operation over a sandbox. */
export async function applyPatchOperation(
  sandbox: Sandbox,
  operation: { type: string; path: string; diff?: string },
): Promise<{ output: string; error?: boolean }> {
  const relative = workspacePath(sandbox.root, operation.path);
  const diff = operation.diff ?? "";
  if (operation.type === "create_file") {
    const lines = diff.replace(/\r\n/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const content = lines.map((line) => (line.startsWith("+") ? line.slice(1) : line)).join("\n");
    await sandbox.writeFile(relative, content ? `${content}\n` : "");
    return { output: `Created ${relative}` };
  }
  if (operation.type === "delete_file") {
    if (!(await sandbox.exists(relative)))
      return { output: `File not found: ${relative}`, error: true };
    await sandbox.deleteFile(relative);
    return { output: `Deleted ${relative}` };
  }
  if (operation.type === "update_file") {
    if (!(await sandbox.exists(relative)))
      return { output: `File not found: ${relative}`, error: true };
    const original = await sandbox.readText(relative);
    try {
      const updated = applyUpdate(original, parseUpdateBody(diff));
      await sandbox.writeFile(relative, updated);
      return { output: `Updated ${relative}` };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), error: true };
    }
  }
  return { output: `Unknown apply_patch operation: ${operation.type}`, error: true };
}

/** Generic function tools for OpenAI-compatible chat providers (OpenRouter). */
export const genericTools = [
  {
    name: "run_command",
    description:
      "Run a shell command in the project sandbox (bash, Node.js, pnpm, python are available). Returns stdout, stderr and the exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000)" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the project. Returns the content with line numbers.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file in the project with the given content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace exactly one occurrence of old_text with new_text in a file. Fails when old_text is missing or ambiguous.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    description: "List every file in the project (ignoring node_modules and build output).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

export async function runGenericTool(
  sandbox: Sandbox,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; onOutput?: (chunk: string) => void } = {},
): Promise<{ output: string; error?: boolean }> {
  switch (name) {
    case "run_command": {
      const result = await runShell(sandbox, String(args.command ?? ""), {
        timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        signal: options.signal,
        onOutput: options.onOutput,
      });
      return { output: result.output, error: result.exitCode !== 0 };
    }
    case "read_file":
      return textEditor(sandbox, { command: "view", path: args.path });
    case "write_file":
      return textEditor(sandbox, { command: "create", path: args.path, file_text: args.content });
    case "edit_file":
      return textEditor(sandbox, {
        command: "str_replace",
        path: args.path,
        old_str: args.old_text,
        new_str: args.new_text,
      });
    case "list_files":
      return textEditor(sandbox, { command: "view", path: "." });
    default:
      return { output: `Unknown tool: ${name}`, error: true };
  }
}
