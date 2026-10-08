import type { Sandbox } from "./sandbox/types.ts";

/**
 * How a project is previewed: the command that serves it, the port it
 * listens on, and the directory the built-in static server serves. Stored in
 * the project as `sparkbox.json` so the agent can set it with a file write
 * and it travels with the files.
 */
export type PreviewConfig = { command: string; port: number; directory: string };

export const configFile = "sparkbox.json";
export const defaultPreviewPort = 8080;

export function defaultPreviewConfig(): PreviewConfig {
  return {
    command: `node .sparkbox/serve.mjs ${defaultPreviewPort} .`,
    port: defaultPreviewPort,
    directory: ".",
  };
}

export async function readPreviewConfig(sandbox: Sandbox): Promise<PreviewConfig> {
  const fallback = defaultPreviewConfig();
  if (!(await sandbox.exists(configFile))) return fallback;
  try {
    const parsed = JSON.parse(await sandbox.readText(configFile)) as {
      preview?: Partial<PreviewConfig>;
    };
    const preview = parsed.preview ?? {};
    const port =
      typeof preview.port === "number" && preview.port > 0 && preview.port < 65536
        ? Math.floor(preview.port)
        : fallback.port;
    const directory =
      typeof preview.directory === "string" && preview.directory.trim()
        ? preview.directory.trim()
        : fallback.directory;
    const command =
      typeof preview.command === "string" && preview.command.trim()
        ? preview.command.trim()
        : `node .sparkbox/serve.mjs ${port} ${directory}`;
    return { command, port, directory };
  } catch {
    return fallback;
  }
}

export async function writePreviewConfig(sandbox: Sandbox, config: Partial<PreviewConfig>) {
  const current = await readPreviewConfig(sandbox);
  const next: PreviewConfig = {
    command: config.command?.trim() || current.command,
    port: config.port ?? current.port,
    directory: config.directory?.trim() || current.directory,
  };
  // A static-server command follows the port and directory unless custom.
  if (/^node \.sparkbox\/serve\.mjs/.test(next.command) && !config.command)
    next.command = `node .sparkbox/serve.mjs ${next.port} ${next.directory}`;
  let existing: Record<string, unknown> = {};
  if (await sandbox.exists(configFile)) {
    try {
      existing = JSON.parse(await sandbox.readText(configFile)) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  await sandbox.writeFile(
    configFile,
    `${JSON.stringify({ ...existing, preview: next }, null, 2)}\n`,
  );
  return next;
}
