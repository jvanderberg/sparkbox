import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guestCommands, guestToolFiles } from "../src/sandbox/guest-tools.ts";

const files = guestToolFiles();
const script = (command: string) => {
  const source = files[`.sparkbox/bin/${command}`];
  if (!source) throw new Error(`no ${command} command`);
  return source;
};
/** Run one of the bash commands with the host's bash. */
function run(command: string, args: string[], cwd = tmpdir()) {
  const result = spawnSync("bash", ["-c", script(command), command, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("guest tools", () => {
  it("gives every command a wrapper whose program is installed", () => {
    expect(guestCommands).toEqual(
      expect.arrayContaining(["clear", "curl", "diff", "find", "less", "tsx", "which", "xargs"]),
    );
    for (const command of guestCommands) {
      const wrapper = script(command);
      expect(wrapper.startsWith("#!/bin/bash\n")).toBe(true);
      for (const [, program] of wrapper.matchAll(/\/workspace\/(\.sparkbox\/tools\/[\w.-]+)/g))
        expect(files[program as string], `${command} runs ${program}`).toBeDefined();
    }
    expect(files[".sparkbox/tools/tsx.mjs"]).not.toContain("__BRIDGE_PORT__");
    expect(files[".sparkbox/tools/pipe-stdout.cjs"]).toBeDefined();
  });

  it("writes bash that parses", () => {
    for (const command of guestCommands) {
      const result = spawnSync("bash", ["-n"], { input: script(command), encoding: "utf8" });
      expect(result.stderr, command).toBe("");
      expect(result.status, command).toBe(0);
    }
  });

  it("stops a command that runs too long, and passes a quick one's status through", () => {
    const slow = run("timeout", ["0.3", "sleep", "5"]);
    expect(slow.status).toBe(124);
    expect(run("timeout", ["5", "sh", "-c", "exit 3"]).status).toBe(3);
    expect(run("timeout", ["5", "echo", "fast"]).stdout).toBe("fast\n");
    expect(run("timeout", ["soon", "true"]).status).toBe(125);
  });

  it("finds commands on the PATH and fails for unknown ones", () => {
    const found = run("which", ["sh", "no-such-command-here"]);
    expect(found.stdout).toMatch(/\/sh\n$/);
    expect(found.status).toBe(1);
  });

  it("accepts chmod for files that exist and reports ones that do not", () => {
    const directory = mkdtempSync(join(tmpdir(), "sparkbox-chmod-"));
    writeFileSync(join(directory, "script.sh"), "echo hi\n");
    expect(run("chmod", ["+x", "script.sh"], directory).status).toBe(0);
    const missing = run("chmod", ["-R", "755", "missing"], directory);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("cannot access 'missing'");
  });

  it("refuses to open the editor outside the Terminal", () => {
    const result = run("vi", ["notes.md"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("from the Terminal only");
  });
});
