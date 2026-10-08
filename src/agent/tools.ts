import type { PreviewViewport } from "../preview-bridge.ts";
import type { PreviewConfig } from "../preview-config.ts";
import { type Sandbox, workspacePath } from "../sandbox/types.ts";
import { FILE_LIMIT } from "../workspace/types.ts";
import { applyUpdate, parseUpdateBody } from "./apply-patch.ts";
import type { GitHubController } from "./github-controller.ts";
import type { PreviewController } from "./preview-controller.ts";
import { type Secrets, substituteSecrets } from "./secrets.ts";

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

/**
 * Tools that run in the page rather than in the sandbox, available to every
 * provider: fetching from the internet, and looking at the running app.
 */
export const pageTools = [
  {
    name: "download",
    description:
      "Download a URL with the browser and save it into the project. Works for servers that allow cross-origin reads (open-data portals, GitHub raw files, npm and CDNs); if the server blocks it, the error says so and the user can upload the file instead. Max 25 MiB.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to fetch" },
        path: {
          type: "string",
          description:
            "Where to save it, relative to the project (default data/<filename from the URL>)",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "preview",
    description:
      "Look at or control the running app. Starts the preview if needed. format: 'screenshot' (image at the chosen viewport), 'text' (headings, links, buttons, inputs, images, stylesheet status and visible text, plus overflow info), 'html' (current DOM), 'errors' (page errors on a fresh load plus those the user hit), 'logs' (the preview server's output), 'status' (current command, port, directory, running state), 'configure' (set the preview command, port and/or directory, saved to sparkbox.json; restarts the server), 'restart'. viewport: 'phone' (390x844), 'tablet' (820x1180) or 'desktop' (1280x800). scheme: 'light' or 'dark' to check that color scheme; default is the user's system setting. Screenshots are a close rendering, not a pixel-exact capture; ask the user to paste a screenshot into the chat when exact appearance matters.",
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["screenshot", "text", "html", "errors", "logs", "status", "configure", "restart"],
        },
        viewport: { type: "string", enum: ["phone", "tablet", "desktop"] },
        scheme: { type: "string", enum: ["light", "dark"] },
        path: { type: "string", description: "Page path to open, default /" },
        command: {
          type: "string",
          description: "For configure: the shell command that serves the app (runs in /workspace)",
        },
        port: { type: "number", description: "For configure: the port that command listens on" },
        directory: {
          type: "string",
          description: "For configure: the directory the built-in static server serves (default .)",
        },
      },
      required: ["format"],
      additionalProperties: false,
    },
  },
  {
    name: "github",
    description:
      "The project's GitHub side. action 'status': whether GitHub is connected, the repository and site URLs, uncommitted changes and the last build outcome. 'runs': the latest GitHub Actions runs (the Pages build) with status and conclusion. 'logs': the failing steps and log tail of the latest failed run, or of the run given by number, to see why a build failed. Pushing is done with the git command.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "runs", "logs"] },
        run: {
          type: "number",
          description: "For logs: a run id from 'runs' (default: the latest failed run)",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
] as const;

export async function githubTool(
  controller: GitHubController | undefined,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  if (!controller) return { output: "GitHub is not available in this session.", error: true };
  const action = String(args.action ?? "status");
  try {
    if (action === "runs") return { output: truncate(await controller.runs()) };
    if (action === "logs")
      return {
        output: truncate(
          await controller.logs(typeof args.run === "number" ? args.run : undefined),
          outputLimit * 2,
        ),
      };
    return { output: truncate(await controller.status()) };
  } catch (error) {
    return { output: error instanceof Error ? error.message : String(error), error: true };
  }
}

export type ToolOutcome = {
  output: string;
  error?: boolean;
  image?: { data: string; mime: "image/jpeg" | "image/png"; width: number; height: number };
};

function filenameFromUrl(url: URL) {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  return last && !last.includes("..") ? decodeURIComponent(last) : "download";
}

/** The host's fetch proxy, used when the browser itself is refused. */
export type FetchProxy = { url: string; token: string };

export async function downloadTool(
  sandbox: Sandbox,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  proxy?: FetchProxy,
  secrets: Secrets = {},
): Promise<ToolOutcome> {
  // ${NAME} placeholders name project secrets; messages show the URL as written.
  const written = String(args.url ?? "");
  let url: URL;
  try {
    url = new URL(substituteSecrets(written, secrets));
  } catch {
    return { output: "A valid http(s) URL is required.", error: true };
  }
  const shown = written;
  if (!/^https?:$/.test(url.protocol))
    return { output: "Only http and https URLs can be downloaded.", error: true };
  const relative = workspacePath(
    sandbox.root,
    typeof args.path === "string" && args.path.trim() ? args.path : `data/${filenameFromUrl(url)}`,
  );
  if (!relative) return { output: "A file path is required.", error: true };
  let response: Response;
  let via = "";
  try {
    response = await fetch(url, { signal, mode: "cors", credentials: "omit" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!proxy || signal?.aborted)
      return {
        output: `Could not fetch ${shown}: ${reason}. The server probably does not allow cross-origin reads. Ask the user to download the file and upload it through Files, or use a source that supports CORS.`,
        error: true,
      };
    // The site refused the browser (no CORS headers); let the host fetch it.
    try {
      response = await fetch(`${proxy.url}?url=${encodeURIComponent(url.href)}`, {
        signal,
        headers: { authorization: `Bearer ${proxy.token}` },
      });
    } catch (proxyError) {
      return {
        output: `Could not fetch ${shown}: the browser was refused (${reason}) and the host proxy failed (${proxyError instanceof Error ? proxyError.message : String(proxyError)}). Ask the user to download the file and upload it through Files.`,
        error: true,
      };
    }
    via = " through the host";
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      return {
        output: `Fetching ${shown} through the host failed with HTTP ${response.status}${detail.error ? `: ${detail.error}` : ""}.`,
        error: true,
      };
    }
  }
  if (!response.ok)
    return { output: `Fetching ${shown} failed with HTTP ${response.status}.`, error: true };
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > FILE_LIMIT) return { output: "The file exceeds the 25 MiB limit.", error: true };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > FILE_LIMIT)
    return { output: "The file exceeds the 25 MiB limit.", error: true };
  await sandbox.writeFile(relative, bytes);
  const type = response.headers.get("content-type") ?? "unknown type";
  return { output: `Saved ${relative} (${bytes.byteLength} bytes, ${type})${via}.` };
}

export async function previewTool(
  controller: PreviewController | undefined,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  if (!controller) return { output: "The preview is not available in this session.", error: true };
  const format = String(args.format ?? "text");
  const viewport = (
    ["phone", "tablet", "desktop"].includes(String(args.viewport))
      ? String(args.viewport)
      : "desktop"
  ) as PreviewViewport;
  const path = typeof args.path === "string" && args.path.startsWith("/") ? args.path : "/";
  const scheme =
    args.scheme === "light" || args.scheme === "dark"
      ? (args.scheme as "light" | "dark")
      : undefined;
  const schemeNote = scheme ? `${scheme} scheme (forced)` : "the user's system color scheme";
  const describe = (status: ReturnType<PreviewController["status"]>) =>
    `Preview ${status.running ? `running at ${status.url || "(exposing…)"}` : "not running"}. Command: ${status.config.command}; port ${status.config.port}; static directory ${status.config.directory}.`;
  if (format === "status") return { output: describe(controller.status()) };
  if (format === "logs")
    return { output: truncate(controller.logs() || "(no output yet)", 20_000) };
  if (format === "configure") {
    const next: Partial<PreviewConfig> = {};
    if (typeof args.command === "string" && args.command.trim()) next.command = args.command;
    if (typeof args.port === "number" && args.port > 0) next.port = Math.floor(args.port);
    if (typeof args.directory === "string" && args.directory.trim())
      next.directory = args.directory;
    if (!Object.keys(next).length)
      return { output: "configure needs a command, port or directory.", error: true };
    try {
      await controller.configure(next);
      return { output: `Saved sparkbox.json. ${describe(controller.status())}` };
    } catch (error) {
      return {
        output: `Could not apply the preview settings: ${error instanceof Error ? error.message : String(error)}\nServer output:\n${truncate(controller.logs(), 4000)}`,
        error: true,
      };
    }
  }
  if (format === "restart") {
    try {
      await controller.restart();
      return {
        output: `Restarted. ${describe(controller.status())}\nRecent output:\n${truncate(controller.logs(), 4000)}`,
      };
    } catch (error) {
      return {
        output: `The preview did not come back: ${error instanceof Error ? error.message : String(error)}\nOutput:\n${truncate(controller.logs(), 4000)}`,
        error: true,
      };
    }
  }
  try {
    await controller.ensureRunning();
  } catch (error) {
    return {
      output: `The preview could not start: ${error instanceof Error ? error.message : String(error)}\nServer output:\n${truncate(controller.logs(), 4000)}`,
      error: true,
    };
  }
  try {
    switch (format) {
      case "screenshot": {
        const result = await controller.query({ format: "screenshot", viewport, path, scheme });
        if (result.format !== "screenshot") throw new Error("unexpected result");
        return {
          output: `Screenshot of ${path} at ${viewport} size (${result.width}x${result.height}), ${schemeNote}, rendered by ${result.renderer}. ${result.images.loaded} of ${result.images.total} images had loaded${result.images.loaded < result.images.total ? "; retake if the missing ones matter" : ""}. A close rendering, not a pixel-exact capture.`,
          image: {
            data: result.image,
            mime: result.mime,
            width: result.width,
            height: result.height,
          },
        };
      }
      case "html": {
        const result = await controller.query({ format: "html", viewport, path, scheme });
        if (result.format !== "html") throw new Error("unexpected result");
        return { output: truncate(result.html, 60_000) };
      }
      case "errors": {
        const result = await controller.query({ format: "errors", viewport, path, scheme });
        if (result.format !== "errors") throw new Error("unexpected result");
        const recent = controller.recentErrors();
        return {
          output: [
            `Errors on a fresh load of ${path} at ${viewport} size: ${result.errors.length ? `\n${result.errors.join("\n")}` : "none"}`,
            `Errors reported while the user used the preview: ${recent.length ? `\n${recent.join("\n")}` : "none"}`,
          ].join("\n\n"),
        };
      }
      default: {
        const result = await controller.query({ format: "text", viewport, path, scheme });
        if (result.format !== "text") throw new Error("unexpected result");
        return { output: truncate(result.text, 20_000) };
      }
    }
  } catch (error) {
    return {
      output: `Could not read the preview: ${error instanceof Error ? error.message : String(error)}`,
      error: true,
    };
  }
}

/** Run a page tool by name, or return null when the name is not one. */
export async function runPageTool(
  name: string,
  args: Record<string, unknown>,
  context: {
    sandbox: Sandbox;
    preview?: PreviewController;
    github?: GitHubController;
    signal?: AbortSignal;
    fetchProxy?: FetchProxy;
    secrets?: Secrets;
  },
): Promise<ToolOutcome | null> {
  if (name === "download")
    return downloadTool(
      context.sandbox,
      args,
      context.signal,
      context.fetchProxy,
      context.secrets ?? {},
    );
  if (name === "preview") return previewTool(context.preview, args);
  if (name === "github") return githubTool(context.github, args);
  return null;
}
