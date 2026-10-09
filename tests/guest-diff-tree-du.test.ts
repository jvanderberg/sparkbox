import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The sandbox shell tools run here on the host's Node; they use only node: built-ins.
const toolsDir = path.resolve("src/sandbox/guest/tools");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "sparkbox-tools-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function run(tool: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [path.join(toolsDir, `${tool}.mjs`), ...args], {
    cwd: tmp,
    input: input ?? "",
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Write files below the temporary directory; a trailing slash makes a directory. */
function files(tree: Record<string, string>) {
  for (const [name, content] of Object.entries(tree)) {
    const full = path.join(tmp, name);
    if (name.endsWith("/")) {
      mkdirSync(full, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

const lines = (...items: string[]) => items.map((item) => `${item}\n`).join("");
const stamp = /\t\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9} [+-]\d{4}$/;
// Unified output without the two header lines, whose times vary.
const hunks = (stdout: string) => stdout.split("\n").slice(2).join("\n");

describe("diff", () => {
  it("exits 0 with no output for identical files, and -s reports them", () => {
    files({ a: lines("x", "y"), b: lines("x", "y") });
    expect(run("diff", ["a", "b"])).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(run("diff", ["-s", "a", "b"]).stdout).toBe("Files a and b are identical\n");
  });

  it("prints normal output for changes, additions and deletions at the edges", () => {
    files({
      base: lines("a", "b", "c"),
      changed: lines("a", "B", "c"),
      start: lines("new", "a", "b", "c"),
      end: lines("a", "b", "c", "new"),
      noFirst: lines("b", "c"),
      noLast: lines("a", "b"),
    });
    const diff = (other: string) => run("diff", ["base", other]);
    expect(diff("changed")).toEqual({ status: 1, stdout: "2c2\n< b\n---\n> B\n", stderr: "" });
    expect(diff("start").stdout).toBe("0a1\n> new\n");
    expect(diff("end").stdout).toBe("3a4\n> new\n");
    expect(diff("noFirst").stdout).toBe("1d0\n< a\n");
    expect(diff("noLast").stdout).toBe("3d2\n< c\n");
    expect(run("diff", ["noFirst", "end"]).stdout).toBe("0a1\n> a\n2a4\n> new\n");
  });

  it("prints unified output with GNU headers and hunk ranges", () => {
    files({ base: lines("a", "b", "c"), changed: lines("a", "B", "c"), end: lines("a", "b") });
    const result = run("diff", ["-u", "base", "changed"]);
    expect(result.status).toBe(1);
    const [from, to] = result.stdout.split("\n");
    expect(from).toMatch(/^--- base\t/);
    expect(from).toMatch(stamp);
    expect(to).toMatch(/^\+\+\+ changed\t/);
    expect(to).toMatch(stamp);
    expect(hunks(result.stdout)).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    // Empty ranges name the line before them; ranges of one line drop ",1".
    expect(hunks(run("diff", ["-U0", "base", "end"]).stdout)).toBe("@@ -3 +2,0 @@\n-c\n");
    expect(hunks(run("diff", ["-U", "0", "end", "base"]).stdout)).toBe("@@ -2,0 +3 @@\n+c\n");
    expect(hunks(run("diff", ["--unified=1", "end", "base"]).stdout)).toBe(
      "@@ -2 +2,2 @@\n b\n+c\n",
    );
    files({ empty: "" });
    expect(hunks(run("diff", ["-u", "empty", "end"]).stdout)).toBe("@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(run("diff", ["-u", "--label", "old", "--label", "new", "base", "end"]).stdout).toBe(
      "--- old\n+++ new\n@@ -1,3 +1,2 @@\n a\n b\n-c\n",
    );
  });

  it("splits unified hunks more than twice the context apart", () => {
    const numbers = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const edit = (...at: number[]) =>
      lines(...numbers.map((n, i) => (at.includes(i + 1) ? `${n}!` : n)));
    files({ a: lines(...numbers), far: edit(2, 18), near: edit(2, 9) });
    const far = hunks(run("diff", ["-u", "a", "far"]).stdout);
    expect(far.match(/^@@.*@@$/gm)).toEqual(["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
    const near = hunks(run("diff", ["-u", "a", "near"]).stdout);
    expect(near.match(/^@@.*@@$/gm)).toEqual(["@@ -1,12 +1,12 @@"]);
  });

  it("marks a missing newline at the end of a file", () => {
    files({ a: "a\nb\n", b: "a\nb", c: "a\nb\nc" });
    expect(run("diff", ["a", "b"]).stdout).toBe(
      "2c2\n< b\n---\n> b\n\\ No newline at end of file\n",
    );
    expect(hunks(run("diff", ["-u", "a", "b"]).stdout)).toBe(
      "@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n",
    );
    expect(run("diff", ["b", "c"]).stdout).toBe(
      "2c2,3\n< b\n\\ No newline at end of file\n---\n> b\n> c\n\\ No newline at end of file\n",
    );
  });

  it("reports only whether files differ with -q", () => {
    files({ a: "1\n", b: "2\n" });
    expect(run("diff", ["-q", "a", "b"])).toEqual({
      status: 1,
      stdout: "Files a and b differ\n",
      stderr: "",
    });
    expect(run("diff", ["--brief", "a", "a"]).stdout).toBe("");
  });

  it("reads standard input for -", () => {
    files({ b: lines("one", "two") });
    expect(run("diff", ["-", "b"], lines("one", "three")).stdout).toBe(
      "2c2\n< three\n---\n> two\n",
    );
    const unified = run("diff", ["-u", "b", "-"], lines("one", "two", "three"));
    expect(unified.stdout.split("\n")[1]).toMatch(/^\+\+\+ -\t/);
  });

  it("reports binary files", () => {
    writeFileSync(path.join(tmp, "x.bin"), Buffer.from([1, 0, 2]));
    writeFileSync(path.join(tmp, "y.bin"), Buffer.from([1, 0, 3]));
    expect(run("diff", ["x.bin", "y.bin"])).toEqual({
      status: 1,
      stdout: "Binary files x.bin and y.bin differ\n",
      stderr: "",
    });
  });

  it("compares directories, recursively with -r", () => {
    files({
      "l/same": "s\n",
      "r/same": "s\n",
      "l/f": "1\n",
      "r/f": "2\n",
      "l/gone": "g\n",
      "l/sub/x": "x\n",
      "r/sub/x": "y\n",
      "r/sub/new": "n\n",
    });
    expect(run("diff", ["l", "r"]).stdout).toBe(
      "diff l/f r/f\n1c1\n< 1\n---\n> 2\nOnly in l: gone\nCommon subdirectories: l/sub and r/sub\n",
    );
    expect(run("diff", ["-rq", "l", "r"])).toEqual({
      status: 1,
      stdout:
        "Files l/f and r/f differ\nOnly in l: gone\nOnly in r/sub: new\nFiles l/sub/x and r/sub/x differ\n",
      stderr: "",
    });
    const unified = run("diff", ["-r", "-u", "l", "r"]).stdout;
    expect(unified).toContain("diff -r -u l/sub/x r/sub/x\n--- l/sub/x\t");
    expect(unified).toContain("Only in r/sub: new\n");
    const newFile = run("diff", ["-Nru", "l", "r"]).stdout;
    expect(newFile).toContain("diff -Nru l/gone r/gone\n");
    expect(newFile).toContain("@@ -1 +0,0 @@\n-g\n");
    expect(newFile).not.toContain("Only in");
    expect(run("diff", ["-rq", "-x", "sub", "l", "r"]).stdout).not.toContain("sub");
    // A file against a directory compares it with the same name inside.
    expect(run("diff", ["l/f", "r"]).stdout).toBe("1c1\n< 1\n---\n> 2\n");
  });

  it("ignores case, white space and blank lines on request", () => {
    files({ a: lines("Hello  world", "x"), b: lines("hello world", "", "x ") });
    expect(run("diff", ["-i", "a", "b"]).status).toBe(1);
    expect(run("diff", ["-i", "-b", "-B", "a", "b"]).status).toBe(0);
    expect(run("diff", ["-iwB", "a", "b"]).stdout).toBe("");
    expect(run("diff", ["-ib", "a", "b"]).stdout).toBe("1a2\n> \n");
  });

  it("colors unified output only when asked", () => {
    files({ a: "1\n", b: "2\n" });
    expect(run("diff", ["-u", "a", "b"]).stdout).not.toContain("\x1b[");
    const colored = run("diff", ["-u", "--color=always", "a", "b"]).stdout;
    expect(colored).toContain("\x1b[31m-1\x1b[0m\n\x1b[32m+2\x1b[0m\n");
    expect(colored).toContain("\x1b[36m@@ -1 +1 @@\x1b[0m");
  });

  it("reports trouble with exit status 2", () => {
    files({ a: "1\n" });
    expect(run("diff", ["a", "missing"])).toEqual({
      status: 2,
      stdout: "",
      stderr: "diff: missing: No such file or directory\n",
    });
    expect(run("diff", ["a"]).status).toBe(2);
    expect(run("diff", ["-Z", "a", "a"]).status).toBe(2);
  });

  it("produces minimal diffs that turn the first file into the second", () => {
    // Deterministic pseudo-random files over a tiny alphabet, so lines repeat.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const make = () => {
      const count = Math.floor(random() * 12);
      const body = Array.from({ length: count }, () => "abc"[Math.floor(random() * 3)]).join("\n");
      return count > 0 && random() < 0.8 ? `${body}\n` : body;
    };
    for (let round = 0; round < 25; round++) {
      const a = make();
      const b = make();
      files({ a, b });
      const normal = run("diff", ["a", "b"]);
      const unified = run("diff", ["-u", "a", "b"]);
      expect(normal.status).toBe(a === b ? 0 : 1);
      expect(applyNormal(a, normal.stdout), `normal ${JSON.stringify([a, b])}`).toBe(b);
      expect(applyUnified(a, unified.stdout), `unified ${JSON.stringify([a, b])}`).toBe(b);
      const edits = normal.stdout.split("\n").filter((line) => /^[<>] /.test(line)).length;
      expect(edits).toBe(minimalEdits(a, b));
    }
  });

  it("handles a few thousand lines quickly", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `line ${i % 701}`);
    const b = a.map((line, i) => (i % 7 === 0 ? `changed ${i}` : line));
    files({ a: lines(...a), b: lines(...b) });
    const started = Date.now();
    const result = run("diff", ["a", "b"]);
    expect(result.status).toBe(1);
    expect(applyNormal(lines(...a), result.stdout)).toBe(lines(...b));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// Lines with their terminators, so a missing final newline survives.
const split = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function applyNormal(original: string, patch: string): string {
  const source = split(original);
  const result: string[] = [];
  let next = 0;
  let last: "<" | ">" | null = null;
  for (const line of split(patch)) {
    const command = /^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?\n$/.exec(line);
    if (command) {
      const from = Number(command[1]);
      const upTo = command[3] === "a" ? from : from - 1;
      while (next < upTo) result.push(source[next++] ?? "");
      if (command[3] !== "a") next = Number(command[2] ?? command[1]);
      continue;
    }
    if (line.startsWith("> ")) {
      result.push(line.slice(2));
      last = ">";
    } else if (line.startsWith("< ")) last = "<";
    else if (line.startsWith("\\") && last === ">") {
      result.push((result.pop() ?? "").replace(/\n$/, ""));
    }
  }
  while (next < source.length) result.push(source[next++] ?? "");
  return result.join("");
}

function applyUnified(original: string, patch: string): string {
  const source = split(original);
  const result: string[] = [];
  let next = 0;
  let last = "";
  for (const line of split(patch).slice(2)) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@\n$/.exec(line);
    if (hunk) {
      const start = Number(hunk[1]);
      const upTo = hunk[2] === "0" ? start : start - 1;
      while (next < upTo) result.push(source[next++] ?? "");
      continue;
    }
    const kind = line[0];
    if (kind === " ") result.push(source[next++] ?? "");
    else if (kind === "-") next++;
    else if (kind === "+") result.push(line.slice(1));
    else if (kind === "\\" && last === "+") result.push((result.pop() ?? "").replace(/\n$/, ""));
    last = kind ?? "";
  }
  while (next < source.length) result.push(source[next++] ?? "");
  return result.join("");
}

// Lines deleted plus lines inserted in a shortest edit script (via the LCS).
function minimalEdits(a: string, b: string): number {
  const x = split(a);
  const y = split(b);
  const table = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) {
      const row = table[i] as number[];
      row[j] =
        x[i] === y[j]
          ? ((table[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((table[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  const common = (table[0] as number[])[0] as number;
  return x.length + y.length - 2 * common;
}

describe("tree", () => {
  beforeEach(() => {
    files({
      "README.md": "hi\n",
      ".env": "SECRET=1\n",
      "src/main.ts": "x\n",
      "src/lib/util.ts": "y\n",
      "src/lib/util.test.ts": "z\n",
      "empty/": "",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
      ".git/HEAD": "ref: refs/heads/main\n",
    });
  });

  it("draws the tree with a summary", () => {
    expect(run("tree", [])).toEqual({
      status: 0,
      stdout: [
        ".",
        "├── README.md",
        "├── empty",
        "├── node_modules/ …",
        "└── src",
        "    ├── lib",
        "    │   ├── util.test.ts",
        "    │   └── util.ts",
        "    └── main.ts",
        "",
        "4 directories, 4 files",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it("limits depth with -L and lists directories with -d", () => {
    expect(run("tree", ["-L", "1", "src"]).stdout).toBe(
      "src\n├── lib\n└── main.ts\n\n1 directory, 1 file\n",
    );
    expect(run("tree", ["-d"]).stdout).toBe(
      ".\n├── empty\n├── node_modules/ …\n└── src\n    └── lib\n\n4 directories\n",
    );
  });

  it("shows dotfiles with -a and still does not descend into .git or node_modules", () => {
    const { stdout } = run("tree", ["-a", "--noreport", "-L", "1"]);
    expect(stdout).toBe(
      ".\n├── .env\n├── .git\n├── README.md\n├── empty\n├── node_modules\n└── src\n",
    );
    const all = run("tree", ["-a"]).stdout;
    expect(all).toContain("├── .git/ …\n");
    expect(all).not.toContain("HEAD");
    expect(all).not.toContain("index.js");
  });

  it("descends into node_modules when it is named", () => {
    expect(run("tree", ["node_modules"]).stdout).toBe(
      "node_modules\n└── pkg\n    └── index.js\n\n1 directory, 1 file\n",
    );
  });

  it("filters with -I and -P", () => {
    expect(run("tree", ["-I", "node_modules|*.test.ts|empty"]).stdout).toBe(
      ".\n├── README.md\n└── src\n    ├── lib\n    │   └── util.ts\n    └── main.ts\n\n2 directories, 3 files\n",
    );
    expect(run("tree", ["-P", "*.md", "--noreport", "-L", "1"]).stdout).toBe(
      ".\n├── README.md\n├── empty\n├── node_modules\n└── src\n",
    );
  });

  it("prints full paths, sizes and directories first", () => {
    expect(run("tree", ["-f", "--dirsfirst", "--noreport", "src"]).stdout).toBe(
      "src\n├── src/lib\n│   ├── src/lib/util.test.ts\n│   └── src/lib/util.ts\n└── src/main.ts\n",
    );
    expect(run("tree", ["-s", "--noreport", "-I", "lib", "src"]).stdout).toMatch(
      /\n└── \[ {10}2\] {2}main\.ts\n$/,
    );
    expect(run("tree", ["-h", "--noreport", "-I", "lib", "src"]).stdout).toMatch(
      /\n└── \[ {3}2\] {2}main\.ts\n$/,
    );
  });

  it("colors directories with -C and reports a missing directory", () => {
    expect(run("tree", ["-C", "-L", "1", "src"]).stdout).toContain("├── \x1b[1;34mlib\x1b[0m\n");
    expect(run("tree", ["missing"])).toEqual({
      status: 2,
      stdout: "missing  [error opening dir]\n\n0 directories, 0 files\n",
      stderr: "",
    });
  });
});

describe("du", () => {
  const sizes = (...names: string[]) =>
    names.reduce((total, name) => total + lstatSync(path.join(tmp, name)).size, 0);
  const blocks = (bytes: number) => Math.ceil(bytes / 1024);

  beforeEach(() => {
    files({ "d/a": "x".repeat(3000), "d/sub/b": "y".repeat(1536), "d/sub/c": "" });
  });

  it("prints directories in post-order with 1K blocks by default", () => {
    const sub = sizes("d/sub", "d/sub/b", "d/sub/c");
    const total = sub + sizes("d", "d/a");
    expect(run("du", ["d"])).toEqual({
      status: 0,
      stdout: `${blocks(sub)}\td/sub\n${blocks(total)}\td\n`,
      stderr: "",
    });
    expect(run("du", ["-s", "d"]).stdout).toBe(`${blocks(total)}\td\n`);
    expect(run("du", ["-d", "0", "d"]).stdout).toBe(`${blocks(total)}\td\n`);
    expect(run("du", ["--max-depth=1", "-a", "-b", "d"]).stdout).toBe(
      `3000\td/a\n${sub}\td/sub\n${total}\td\n`,
    );
  });

  it("lists files with -a and adds a total with -c", () => {
    const { stdout } = run("du", ["-ab", "d/sub"]);
    expect(stdout.split("\n").slice(0, 2)).toEqual(["1536\td/sub/b", "0\td/sub/c"]);
    expect(run("du", ["-c", "d/a", "d/sub/b"]).stdout).toBe("3\td/a\n2\td/sub/b\n5\ttotal\n");
  });

  it("prints human readable sizes like GNU", () => {
    files({ k1: "x".repeat(1025), k10: "x".repeat(10240), small: "x".repeat(512), zero: "" });
    expect(run("du", ["-h", "d/sub/b", "k1", "k10", "small", "zero"]).stdout).toBe(
      "1.5K\td/sub/b\n1.1K\tk1\n10K\tk10\n512\tsmall\n0\tzero\n",
    );
    expect(run("du", ["-m", "k10"]).stdout).toBe("1\tk10\n");
  });

  it("excludes names and reports missing paths", () => {
    expect(run("du", ["-ab", "--exclude=sub", "d"]).stdout).not.toContain("sub");
    expect(run("du", ["missing"])).toEqual({
      status: 1,
      stdout: "",
      stderr: "du: cannot access 'missing': No such file or directory\n",
    });
  });
});
