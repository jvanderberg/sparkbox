/**
 * The page side of the sandbox's `git` command: writes the shim and the
 * bridge process into the sandbox, starts the bridge, and answers each
 * request by running the command against the page's repository. Everything
 * is rewritten after a runtime rebuild, which loses `.sparkbox/`.
 */
import {
  gitBridgePath,
  gitBridgeScript,
  gitShimPath,
  gitShimScript,
  gitWrapperPath,
  gitWrapperScript,
} from "../sandbox/git-bridge-script.ts";
import type { WasmerSandbox } from "../sandbox/wasmer.ts";
import { type CliResult, runGitCommand } from "./cli.ts";
import type { Repository } from "./repo.ts";

type Request = { id: number; argv: string[]; cwd: string };

export function startGitBridge(sandbox: WasmerSandbox, repo: () => Repository | null) {
  let stopped = false;
  let pipe: { write: (line: string) => Promise<void>; kill: () => Promise<void> } | null = null;
  let queue: Promise<void> = Promise.resolve();

  const answer = async (request: Request) => {
    const current = repo();
    let result: CliResult;
    if (!current)
      result = { stdout: "", stderr: "fatal: the repository is not ready yet.\n", code: 128 };
    else {
      // Paths are relative to the working directory the command ran in.
      const prefix = request.cwd.startsWith(`${sandbox.root}/`)
        ? `${request.cwd.slice(sandbox.root.length + 1)}/`
        : "";
      const argv = prefix
        ? request.argv.map((arg) =>
            arg.startsWith("-") || arg === "." ? (arg === "." ? prefix.slice(0, -1) : arg) : arg,
          )
        : request.argv;
      try {
        result = await runGitCommand(current, argv);
      } catch (error) {
        result = {
          stdout: "",
          stderr: `fatal: ${error instanceof Error ? error.message : String(error)}\n`,
          code: 128,
        };
      }
    }
    await pipe?.write(JSON.stringify({ id: request.id, ...result })).catch(() => {});
  };

  const start = async () => {
    if (stopped) return;
    await sandbox.writeFile(gitWrapperPath, gitWrapperScript);
    await sandbox.writeFile(gitShimPath, gitShimScript);
    await sandbox.writeFile(gitBridgePath, gitBridgeScript);
    // The wrapper must be executable for bash to run it from the PATH.
    await sandbox.exec(`chmod +x ${gitWrapperPath}`, { timeoutMs: 20_000 }).catch(() => {});
    pipe = await sandbox.startPipe(
      `node ${gitBridgePath}`,
      (line) => {
        let request: Request;
        try {
          request = JSON.parse(line) as Request;
        } catch {
          return;
        }
        if (typeof request.id !== "number" || !Array.isArray(request.argv)) return;
        // One command at a time: git's index must not be written concurrently.
        queue = queue.then(() => answer(request)).catch(() => {});
      },
      () => {
        pipe = null;
        // The bridge died (a runtime rebuild, say): bring it back shortly.
        if (!stopped) setTimeout(() => void start().catch(() => {}), 1500);
      },
    );
  };

  void start().catch((error) => console.warn("git bridge did not start", error));
  const detach = sandbox.onRestart(() => void start().catch(() => {}));
  return {
    stop: async () => {
      stopped = true;
      detach();
      await pipe?.kill();
      pipe = null;
    },
  };
}
