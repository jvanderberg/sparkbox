/**
 * Project secrets: values the user stores in Settings for the agent to use
 * without ever seeing them. They reach commands and the preview server as
 * environment variables, download URLs may name them as ${NAME}, and every
 * tool output the model sees has the values replaced by [NAME].
 */
import type { ExecOptions, ExecResult, Sandbox } from "../sandbox/types.ts";

export type Secrets = Record<string, string>;

/** Environment-variable names only: letters, digits and underscores, not starting with a digit. */
export const secretNamePattern = /^[A-Z_][A-Z0-9_]*$/i;

export function isSecretName(name: string) {
  return secretNamePattern.test(name);
}

/** Values of at least four characters are replaced; shorter ones would mangle ordinary text. */
function redactable(secrets: Secrets) {
  return Object.entries(secrets)
    .filter(([name, value]) => isSecretName(name) && value.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
}

export function redactSecrets(text: string, secrets: Secrets): string {
  let out = text;
  for (const [name, value] of redactable(secrets)) out = out.replaceAll(value, `[${name}]`);
  return out;
}

/** Replace ${NAME} placeholders; unknown names are left as written. */
export function substituteSecrets(text: string, secrets: Secrets): string {
  return text.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (match, name: string) =>
    Object.hasOwn(secrets, name) ? (secrets[name] as string) : match,
  );
}

/**
 * The sandbox the agent's tools see: command output and file reads come
 * back redacted. Writes, listings and the rest pass straight through.
 */
export function withSecrets(sandbox: Sandbox, secrets: Secrets): Sandbox {
  if (!redactable(secrets).length) return sandbox;
  const redact = (text: string) => redactSecrets(text, secrets);
  return {
    root: sandbox.root,
    async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
      const result = await sandbox.exec(command, {
        ...options,
        onOutput: options.onOutput
          ? (chunk, stream) => options.onOutput?.(redact(chunk), stream)
          : undefined,
      });
      return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
    },
    readFile: (path) => sandbox.readFile(path),
    readText: async (path) => redact(await sandbox.readText(path)),
    writeFile: (path, data) => sandbox.writeFile(path, data),
    deleteFile: (path) => sandbox.deleteFile(path),
    exists: (path) => sandbox.exists(path),
    mkdir: (path) => sandbox.mkdir(path),
    listFiles: () => sandbox.listFiles(),
    subscribe: (listener) => sandbox.subscribe(listener),
    flush: sandbox.flush ? () => sandbox.flush?.() ?? Promise.resolve() : undefined,
  };
}
