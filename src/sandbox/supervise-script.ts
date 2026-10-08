/**
 * The process supervisor the Preview runs the project's command under.
 *
 * Killing a guest process in the sandbox does not touch the processes it
 * started: a command such as `node server.js & node vite.mjs` leaves the
 * backgrounded server alive, still holding its port, after the preview is
 * stopped, and there are no process groups or a process list to find it
 * with. Every Node process under the command therefore records its pid
 * through a NODE_OPTIONS preload, and the supervisor kills the recorded
 * pids when it is asked to stop or when the command exits on its own.
 *
 * Both files are written to /workspace/.sparkbox/ when the preview starts.
 */
export const supervisePath = ".sparkbox/supervise.mjs";
export const registerPath = ".sparkbox/register.cjs";

export const registerScript = `// Records this process for the preview supervisor; see supervise.mjs.
try {
  if (process.env.SPARKBOX_PIDS)
    require("node:fs").appendFileSync(process.env.SPARKBOX_PIDS, process.pid + "\\n");
} catch {}
`;

export const superviseScript = `import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const command = process.argv[2] || "";
const pidFile = \`/tmp/sparkbox-preview-\${process.pid}-\${Date.now()}.pids\`;
const register = path.resolve("${registerPath}");
writeFileSync(pidFile, "");
const options = [process.env.NODE_OPTIONS, \`--require \${JSON.stringify(register)}\`]
  .filter(Boolean)
  .join(" ");
const child = spawn("bash", ["-c", command], {
  stdio: "inherit",
  env: { ...process.env, SPARKBOX_PIDS: pidFile, NODE_OPTIONS: options },
});

let finished = false;
function recorded() {
  try {
    return readFileSync(pidFile, "utf8").split("\\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
function stop(code) {
  if (finished) return;
  finished = true;
  for (const pid of [...recorded(), child.pid]) {
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  try {
    unlinkSync(pidFile);
  } catch {}
  process.exit(code);
}
child.on("exit", (code, signal) => stop(code ?? (signal ? 1 : 0)));
child.on("error", (error) => {
  console.error(error.message);
  stop(1);
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => stop(143));
`;
