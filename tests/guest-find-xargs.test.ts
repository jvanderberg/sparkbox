import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const findTool = path.resolve("src/sandbox/guest/tools/find.mjs");
const xargsTool = path.resolve("src/sandbox/guest/tools/xargs.mjs");
const roots: string[] = [];

function run(tool: string, args: string[], cwd: string, input = "") {
  const result = spawnSync(process.execPath, [tool, ...args], { cwd, input, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** A small project tree; returns its root. */
function makeTree() {
  const root = mkdtempSync(path.join(tmpdir(), "sparkbox-find-"));
  roots.push(root);
  const files: Record<string, string> = {
    ".hidden": "x",
    "B.TXT": "",
    "a.txt": "hello",
    "src/main.js": "m".repeat(1000),
    "src/lib/util.js": "u",
    "node_modules/pkg/index.js": "i",
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  mkdirSync(path.join(root, "empty"));
  return root;
}

let tree = "";
beforeAll(() => {
  tree = makeTree();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const find = (...args: string[]) => run(findTool, args, tree);
const lines = (...items: string[]) => items.map((item) => `${item}\n`).join("");

describe("find", () => {
  it("lists the tree depth-first, sorted by name, like GNU paths", () => {
    expect(find()).toEqual({
      status: 0,
      stderr: "",
      stdout: lines(
        ".",
        "./.hidden",
        "./B.TXT",
        "./a.txt",
        "./empty",
        "./node_modules",
        "./node_modules/pkg",
        "./node_modules/pkg/index.js",
        "./src",
        "./src/lib",
        "./src/lib/util.js",
        "./src/main.js",
      ),
    });
    expect(find("src").stdout).toBe(lines("src", "src/lib", "src/lib/util.js", "src/main.js"));
    expect(find("src/", "-type", "f").stdout).toBe(lines("src/lib/util.js", "src/main.js"));
  });

  it("matches -name, -iname and -path globs", () => {
    expect(find(".", "-name", "*.txt").stdout).toBe(lines("./a.txt"));
    expect(find(".", "-iname", "*.txt").stdout).toBe(lines("./B.TXT", "./a.txt"));
    expect(find(".", "-name", "[ab].*").stdout).toBe(lines("./a.txt"));
    expect(find(".", "-name", "?.TXT").stdout).toBe(lines("./B.TXT"));
    expect(find(".", "-name", ".*").stdout).toBe(lines(".", "./.hidden"));
    // In -path, `*` also matches `/`.
    expect(find(".", "-path", "./src*.js").stdout).toBe(
      lines("./src/lib/util.js", "./src/main.js"),
    );
    expect(find(".", "-regex", ".*/[a-z]+\\.js").stdout).toBe(
      lines("./node_modules/pkg/index.js", "./src/lib/util.js", "./src/main.js"),
    );
  });

  it("filters by -type and depth", () => {
    expect(find(".", "-type", "d").stdout).toBe(
      lines(".", "./empty", "./node_modules", "./node_modules/pkg", "./src", "./src/lib"),
    );
    expect(find(".", "-maxdepth", "1", "-type", "f").stdout).toBe(
      lines("./.hidden", "./B.TXT", "./a.txt"),
    );
    expect(find("src", "-mindepth", "2").stdout).toBe(lines("src/lib/util.js"));
    expect(find("src", "-type", "f,d", "-maxdepth", "1").stdout).toBe(
      lines("src", "src/lib", "src/main.js"),
    );
  });

  it("combines tests with !, -o and parentheses", () => {
    expect(find("src", "!", "-type", "d").stdout).toBe(lines("src/lib/util.js", "src/main.js"));
    expect(find(".", "-name", "a.txt", "-o", "-name", "util.js").stdout).toBe(
      lines("./a.txt", "./src/lib/util.js"),
    );
    expect(
      find(".", "(", "-name", "*.js", "-o", "-name", "*.txt", ")", "-not", "-path", "*/lib/*")
        .stdout,
    ).toBe(lines("./a.txt", "./node_modules/pkg/index.js", "./src/main.js"));
    // -a binds tighter than -o, and -print sits on the right-hand side only.
    expect(find(".", "-name", "a.txt", "-o", "-name", "main.js", "-print").stdout).toBe(
      lines("./src/main.js"),
    );
  });

  it("tests -size and -empty with GNU rounding", () => {
    expect(find(".", "-type", "f", "-size", "+1").stdout).toBe(lines("./src/main.js"));
    expect(find(".", "-type", "f", "-size", "-2c").stdout).toBe(
      lines("./.hidden", "./B.TXT", "./node_modules/pkg/index.js", "./src/lib/util.js"),
    );
    expect(find(".", "-size", "1000c").stdout).toBe(lines("./src/main.js"));
    expect(find(".", "-type", "f", "-size", "1k").stdout).toBe(
      lines(
        "./.hidden",
        "./a.txt",
        "./node_modules/pkg/index.js",
        "./src/lib/util.js",
        "./src/main.js",
      ),
    );
    expect(find(".", "-empty").stdout).toBe(lines("./B.TXT", "./empty"));
  });

  it("tests -mtime and -newer", () => {
    const root = makeTree();
    const old = Date.now() / 1000 - 3 * 86400;
    utimesSync(path.join(root, "a.txt"), old, old);
    expect(run(findTool, [".", "-type", "f", "-mtime", "+1"], root).stdout).toBe(lines("./a.txt"));
    expect(run(findTool, [".", "-iname", "*.txt", "-newer", "a.txt"], root).stdout).toBe(
      lines("./B.TXT"),
    );
  });

  it("prunes, quits and prints NUL-separated", () => {
    expect(find(".", "-name", "node_modules", "-prune", "-o", "-type", "f", "-print").stdout).toBe(
      lines("./.hidden", "./B.TXT", "./a.txt", "./src/lib/util.js", "./src/main.js"),
    );
    expect(find("src", "-type", "f", "-print0").stdout).toBe("src/lib/util.js\0src/main.js\0");
    expect(find(".", "-name", "*.js", "-print", "-quit").stdout).toBe(
      lines("./node_modules/pkg/index.js"),
    );
  });

  it("deletes depth-first", () => {
    const root = makeTree();
    expect(run(findTool, [".", "-name", "*.js", "-delete"], root)).toMatchObject({
      status: 0,
      stdout: "",
    });
    expect(existsSync(path.join(root, "src/main.js"))).toBe(false);
    expect(existsSync(path.join(root, "src/lib"))).toBe(true);
    // A directory and its contents: the contents go first.
    expect(run(findTool, ["src", "-delete"], root).status).toBe(0);
    expect(existsSync(path.join(root, "src"))).toBe(false);
    // A non-empty directory cannot be deleted on its own.
    const result = run(findTool, [".", "-name", "node_modules", "-delete"], root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^find: cannot delete '\.\/node_modules': /);
  });

  it("runs -exec per file and in batches", () => {
    expect(find("src", "-type", "f", "-exec", "echo", "file:{}", ";").stdout).toBe(
      lines("file:src/lib/util.js", "file:src/main.js"),
    );
    expect(find("src", "-type", "f", "-exec", "echo", "all", "{}", "+").stdout).toBe(
      lines("all src/lib/util.js src/main.js"),
    );
    // -exec is a test: its exit status decides what follows.
    expect(find("src", "-type", "f", "-exec", "grep", "-q", "u", "{}", ";", "-print").stdout).toBe(
      lines("src/lib/util.js"),
    );
  });

  it("reports errors like GNU", () => {
    expect(find(".", "-foo")).toEqual({
      status: 1,
      stdout: "",
      stderr: "find: unknown predicate '-foo'\n",
    });
    expect(find(".", "-name")).toMatchObject({
      status: 1,
      stderr: "find: missing argument to '-name'\n",
    });
    expect(find(".", "-exec", "echo", "{}").stderr).toBe("find: missing argument to '-exec'\n");
    expect(find("missing", "a.txt")).toEqual({
      status: 1,
      stdout: "a.txt\n",
      stderr: "find: 'missing': No such file or directory\n",
    });
  });
});

describe("xargs", () => {
  const xargs = (input: string, ...args: string[]) => run(xargsTool, args, tree, input);

  it("splits on blanks and newlines, honouring quotes and backslashes", () => {
    expect(xargs(`a 'b c' "d e"\n f\\ g ''\n`, "printf", "[%s]\\n").stdout).toBe(
      lines("[a]", "[b c]", "[d e]", "[f g]", "[]"),
    );
    expect(xargs("a b\nc\n").stdout).toBe(lines("a b c"));
    const unmatched = xargs("it's\n");
    expect(unmatched.status).toBe(1);
    expect(unmatched.stderr).toMatch(/^xargs: unmatched single quote/);
  });

  it("splits on NUL with -0 and on a character with -d", () => {
    expect(xargs("a b\0c\0", "-0", "printf", "[%s]\\n").stdout).toBe(lines("[a b]", "[c]"));
    expect(xargs("a b\nc\n", "-d", "\\n", "printf", "[%s]\\n").stdout).toBe(lines("[a b]", "[c]"));
  });

  it("limits arguments with -n and lines with -L", () => {
    expect(xargs("1 2 3 4 5", "-n", "2").stdout).toBe(lines("1 2", "3 4", "5"));
    expect(xargs("1 2\n3\n4 5\n", "-L", "2", "echo").stdout).toBe(lines("1 2 3", "4 5"));
  });

  it("replaces with -I, one command per line", () => {
    expect(xargs("x\n  y z\n\n", "-I", "{}", "echo", "<{}>", "{}").stdout).toBe(
      lines("<x> x", "<y z> y z"),
    );
    expect(xargs("", "-I{}", "echo", "{}").stdout).toBe("");
  });

  it("runs once on empty input unless -r", () => {
    expect(xargs("", "echo", "hi").stdout).toBe(lines("hi"));
    expect(xargs("\n  \n", "-r", "echo", "hi")).toMatchObject({ status: 0, stdout: "" });
  });

  it("prints commands with -t", () => {
    expect(xargs("a b", "-t", "echo")).toMatchObject({ stdout: "a b\n", stderr: "echo a b\n" });
  });

  it("exits 123 when a command fails and 127 when it is missing", () => {
    expect(xargs("a\nb\n", "-n", "1", "false").status).toBe(123);
    const missing = xargs("a", "sparkbox-no-such-command");
    expect(missing.status).toBe(127);
    expect(missing.stderr).toBe("xargs: sparkbox-no-such-command: No such file or directory\n");
  });

  it("takes find -print0 output", () => {
    const found = find(".", "-name", "*.js", "-print0").stdout;
    expect(xargs(found, "-0", "-n", "1", "echo", "js:").stdout).toBe(
      lines("js: ./node_modules/pkg/index.js", "js: ./src/lib/util.js", "js: ./src/main.js"),
    );
  });
});
