// find for the Sparkbox sandbox: a subset of GNU find, written in Node because
// the sandbox has no find binary. What it supports behaves like GNU find;
// anything else is reported as an unknown predicate.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { err, exit, fail, out } from "./io.mjs";

const USAGE = `Usage: find [-P] [path...] [expression]

Options: -maxdepth N -mindepth N -depth -regextype TYPE (ignored)
Tests: -name -iname -path -ipath -wholename -iwholename -regex -iregex
       -type [fdlpsbc] -empty -size [+-]N[cwbkMG] -newer FILE
       -mtime -mmin -atime -amin -ctime -cmin [+-]N -true -false
Operators: ( EXPR ) ! -not -a -and -o -or ,
Actions: -print -print0 -delete -prune -quit -exec CMD {} ; -exec CMD {} +
`;

const startTime = Date.now();
let exitStatus = 0;

// Output is collected and written in blocks: one write per path is slow in
// the sandbox. It is flushed before anything else writes (errors, -exec).
let pending = [];
let pendingLength = 0;
function emit(text) {
  pending.push(text);
  pendingLength += text.length;
  if (pendingLength >= 65536) flush();
}
function flush() {
  if (pending.length === 0) return;
  out(pending.join(""));
  pending = [];
  pendingLength = 0;
}

/** Report a problem with one file and carry on; find exits 1 at the end. */
function warn(message) {
  flush();
  err(`find: ${message}\n`);
  exitStatus = 1;
}

function reason(error) {
  switch (error?.code) {
    case "ENOENT":
      return "No such file or directory";
    case "EACCES":
    case "EPERM":
      return "Permission denied";
    case "ENOTDIR":
      return "Not a directory";
    case "ENOTEMPTY":
      return "Directory not empty";
    case "ELOOP":
      return "Too many levels of symbolic links";
    default:
      return error?.message ?? String(error);
  }
}

// ---------------------------------------------------------------- patterns

// Under the RegExp "u" flag only syntax characters may be escaped, and `-` only inside [].
const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const escapeClass = (text) => text.replace(/[\\^\]-]/g, "\\$&");

const POSIX_CLASSES = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "\\x21-\\x7e",
  lower: "a-z",
  print: "\\x20-\\x7e",
  punct: "!-\\/:-@\\[-`{-~",
  space: "\\s",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
};

/** The regex for a `[...]` at `start`, or null when it never closes (then `[` is literal). */
function bracketToRegExp(pattern, start) {
  let i = start + 1;
  let negate = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true;
    i++;
  }
  let body = "";
  let first = true;
  while (i < pattern.length) {
    let c = pattern[i];
    if (c === "]" && !first) return { source: `[${negate ? "^" : ""}${body}]`, end: i };
    first = false;
    if (c === "[" && pattern[i + 1] === ":") {
      const close = pattern.indexOf(":]", i + 2);
      const name = close === -1 ? "" : pattern.slice(i + 2, close);
      if (name in POSIX_CLASSES) {
        body += POSIX_CLASSES[name];
        i = close + 2;
        continue;
      }
    }
    if (c === "\\" && i + 1 < pattern.length) c = pattern[++i];
    body += escapeClass(c);
    i++;
    // A range such as a-z; a `-` just before `]` is literal.
    if (pattern[i] === "-" && pattern[i + 1] !== undefined && pattern[i + 1] !== "]") {
      let hi = pattern[i + 1];
      i += 2;
      if (hi === "\\" && i < pattern.length) hi = pattern[i++];
      body += `-${escapeClass(hi)}`;
    }
  }
  return null;
}

/** A shell glob (fnmatch without FNM_PATHNAME or FNM_PERIOD, as GNU find uses it) as a RegExp. */
function globToRegExp(pattern, ignoreCase) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (c === "\\" && i + 1 < pattern.length) source += escapeRegExp(pattern[++i]);
    else if (c === "[") {
      const bracket = bracketToRegExp(pattern, i);
      if (bracket) {
        source += bracket.source;
        i = bracket.end;
      } else source += "\\[";
    } else source += escapeRegExp(c);
  }
  try {
    return new RegExp(`^${source}$`, ignoreCase ? "isu" : "su");
  } catch {
    // An invalid range such as [z-a] matches nothing, as in fnmatch.
    return /(?!)/;
  }
}

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
let index = 0;
if (args[0] === "--help" || args[0] === "-help") {
  out(USAGE);
  exit(0);
}
// Leading options. -P (never follow symlinks) is the default and the only mode.
while (index < args.length && /^-[HLP]+$/.test(args[index])) {
  if (/[HL]/.test(args[index])) fail("following symbolic links (-H, -L) is not supported");
  index++;
}
if (args[index] === "--") index++;

// Starting points run until the first argument that looks like an expression.
const looksLikeExpression = (arg) =>
  (arg.startsWith("-") && arg.length > 1) || ["(", ")", "!", ","].includes(arg);
const startingPoints = [];
while (index < args.length && !looksLikeExpression(args[index])) startingPoints.push(args[index++]);
if (startingPoints.length === 0) startingPoints.push(".");

const expression = args.slice(index);
let position = 0;

const options = { maxdepth: Number.POSITIVE_INFINITY, mindepth: 0, depthFirst: false };
let hasAction = false;
const batches = [];
let pruned = false;
const QUIT = Symbol("quit");

function takeArgument(name) {
  if (position >= expression.length) fail(`missing argument to '${name}'`);
  return expression[position++];
}

function depthArgument(name) {
  const value = takeArgument(name);
  if (!/^\d+$/.test(value))
    fail(`Expected a positive decimal integer argument to ${name}, but got '${value}'`);
  return Number(value);
}

/** `[+-]N` as a comparison: +N is more than N, -N less than N, N exactly N. */
function numericTest(name, value) {
  const match = /^([+-]?)(\d+)$/.exec(value);
  if (!match) fail(`invalid argument '${value}' to '${name}'`);
  const n = Number(match[2]);
  if (match[1] === "+") return (x) => x > n;
  if (match[1] === "-") return (x) => x < n;
  return (x) => x === n;
}

const SIZE_UNITS = { c: 1, w: 2, b: 512, k: 1024, M: 1024 ** 2, G: 1024 ** 3 };
const FILE_TYPES = {
  f: (s) => s.isFile(),
  d: (s) => s.isDirectory(),
  l: (s) => s.isSymbolicLink(),
  p: (s) => s.isFIFO(),
  s: (s) => s.isSocket(),
  b: (s) => s.isBlockDevice(),
  c: (s) => s.isCharacterDevice(),
};

/** Run a command with the terminal's stdio; its exit status, or -1 if it did not run. */
function runCommand(argv) {
  flush();
  const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
  if (result.error) {
    warn(`'${argv[0]}': ${reason(result.error)}`);
    return -1;
  }
  return result.status ?? -1;
}

function runBatch(batch) {
  if (batch.paths.length === 0) return;
  const argv = [...batch.command, ...batch.paths];
  batch.paths = [];
  batch.length = 0;
  // GNU find reports a failed `-exec ... +` in its own exit status.
  if (runCommand(argv) !== 0) exitStatus = 1;
}

function parseExec(name) {
  const command = [];
  while (position < expression.length) {
    const arg = expression[position++];
    if (arg === ";") {
      if (command.length === 0) break;
      return (entry) => runCommand(command.map((a) => a.replaceAll("{}", entry.path))) === 0;
    }
    // `+` ends the command only straight after `{}`; elsewhere it is an ordinary argument.
    if (arg === "+" && command.length > 1 && command.at(-1) === "{}") {
      const batch = { command: command.slice(0, -1), paths: [], length: 0 };
      batches.push(batch);
      return (entry) => {
        batch.paths.push(entry.path);
        batch.length += entry.path.length + 1;
        if (batch.paths.length >= 4096 || batch.length >= 65536) runBatch(batch);
        return true;
      };
    }
    command.push(arg);
  }
  return fail(`missing argument to '${name}'`);
}

function timeTest(name, field, unitMs) {
  const test = numericTest(name, takeArgument(name));
  // GNU counts whole elapsed units, rounding down: -mtime 0 is the last 24 hours.
  return (entry) => test(Math.floor((startTime - entry.stat[field]) / unitMs));
}

const always = () => true;

/** Each primary consumes its arguments and returns the test it stands for. */
const PRIMARIES = {
  "-maxdepth": (name) => {
    options.maxdepth = depthArgument(name);
    return always;
  },
  "-mindepth": (name) => {
    options.mindepth = depthArgument(name);
    return always;
  },
  "-depth": () => {
    options.depthFirst = true;
    return always;
  },
  // Patterns for -regex are JavaScript regular expressions whatever the type.
  "-regextype": (name) => {
    takeArgument(name);
    return always;
  },
  // The sandbox has a single file system.
  "-xdev": () => always,
  "-mount": () => always,
  "-noleaf": () => always,
  "-name": (name) => {
    const re = globToRegExp(takeArgument(name), false);
    return (entry) => re.test(entry.name);
  },
  "-iname": (name) => {
    const re = globToRegExp(takeArgument(name), true);
    return (entry) => re.test(entry.name);
  },
  "-path": (name) => {
    const re = globToRegExp(takeArgument(name), false);
    return (entry) => re.test(entry.path);
  },
  "-ipath": (name) => {
    const re = globToRegExp(takeArgument(name), true);
    return (entry) => re.test(entry.path);
  },
  "-regex": (name) => {
    const re = makeRegex(takeArgument(name), "s");
    return (entry) => re.test(entry.path);
  },
  "-iregex": (name) => {
    const re = makeRegex(takeArgument(name), "is");
    return (entry) => re.test(entry.path);
  },
  "-type": (name) => {
    const value = takeArgument(name);
    const tests = value.split(",").map((letter) => {
      if (!(letter in FILE_TYPES)) fail(`Unknown argument to -type: ${letter}`);
      return FILE_TYPES[letter];
    });
    return (entry) => tests.some((test) => test(entry.stat));
  },
  "-empty": () => (entry) => {
    if (entry.stat.isFile()) return entry.stat.size === 0;
    if (!entry.stat.isDirectory()) return false;
    try {
      return readdirSync(entry.path).length === 0;
    } catch (error) {
      warn(`'${entry.path}': ${reason(error)}`);
      return false;
    }
  },
  "-size": (name) => {
    const value = takeArgument(name);
    const match = /^([+-]?\d+)(.?)$/.exec(value);
    if (!match) fail(`invalid argument '${value}' to '${name}'`);
    const unit = SIZE_UNITS[match[2] || "b"];
    if (!unit) fail(`invalid -size type '${match[2]}'`);
    const test = numericTest(name, match[1]);
    // Sizes are rounded up to whole units, so -size -1M matches only empty files.
    return (entry) => test(Math.ceil(entry.stat.size / unit));
  },
  "-mtime": (name) => timeTest(name, "mtimeMs", 86_400_000),
  "-atime": (name) => timeTest(name, "atimeMs", 86_400_000),
  "-ctime": (name) => timeTest(name, "ctimeMs", 86_400_000),
  "-mmin": (name) => timeTest(name, "mtimeMs", 60_000),
  "-amin": (name) => timeTest(name, "atimeMs", 60_000),
  "-cmin": (name) => timeTest(name, "ctimeMs", 60_000),
  "-newer": (name) => {
    const file = takeArgument(name);
    let reference;
    try {
      reference = statSync(file).mtimeMs;
    } catch (error) {
      fail(`'${file}': ${reason(error)}`);
    }
    return (entry) => entry.stat.mtimeMs > reference;
  },
  "-true": () => always,
  "-false": () => () => false,
  "-print": () => {
    hasAction = true;
    return (entry) => {
      emit(`${entry.path}\n`);
      return true;
    };
  },
  "-print0": () => {
    hasAction = true;
    return (entry) => {
      emit(`${entry.path}\0`);
      return true;
    };
  },
  // -prune does nothing under -depth: the directory's contents were already visited.
  "-prune": () => () => {
    if (!options.depthFirst) pruned = true;
    return true;
  },
  // -quit does not count as an action, so `find . -quit` still has a (never reached) -print.
  "-quit": () => () => {
    throw QUIT;
  },
  // -delete implies -depth so that a directory's contents go before it.
  "-delete": () => {
    hasAction = true;
    options.depthFirst = true;
    return (entry) => {
      if (entry.path === ".") return true; // GNU never deletes the starting directory `.`.
      try {
        if (entry.stat.isDirectory()) rmdirSync(entry.path);
        else unlinkSync(entry.path);
        return true;
      } catch (error) {
        warn(`cannot delete '${entry.path}': ${reason(error)}`);
        return false;
      }
    };
  },
  "-exec": (name) => {
    hasAction = true;
    return parseExec(name);
  },
};
PRIMARIES["-wholename"] = PRIMARIES["-path"];
PRIMARIES["-iwholename"] = PRIMARIES["-ipath"];

function makeRegex(pattern, flags) {
  try {
    return new RegExp(`^(?:${pattern})$`, flags);
  } catch (error) {
    return fail(`invalid regular expression '${pattern}': ${error.message}`);
  }
}

// Precedence, loosest first: `,` then -o then -a (or nothing) then `!`.
function parseList() {
  let left = parseOr();
  while (expression[position] === ",") {
    position++;
    const first = left;
    const second = parseOr();
    left = (entry) => {
      first(entry);
      return second(entry);
    };
  }
  return left;
}

function parseOr() {
  let left = parseAnd();
  while (expression[position] === "-o" || expression[position] === "-or") {
    const operator = expression[position++];
    if (position >= expression.length)
      fail(
        `invalid expression; you have used a binary operator '${operator}' with nothing after it.`,
      );
    const first = left;
    const second = parseAnd();
    left = (entry) => first(entry) || second(entry);
  }
  return left;
}

function parseAnd() {
  let left = parseNot();
  while (position < expression.length) {
    const next = expression[position];
    if (next === "-o" || next === "-or" || next === ")" || next === ",") break;
    if (next === "-a" || next === "-and") {
      position++;
      if (position >= expression.length)
        fail(
          `invalid expression; you have used a binary operator '${next}' with nothing after it.`,
        );
    }
    const first = left;
    const second = parseNot();
    left = (entry) => first(entry) && second(entry);
  }
  return left;
}

function parseNot() {
  const token = expression[position];
  if (token === "!" || token === "-not") {
    position++;
    if (position >= expression.length)
      fail(`invalid expression; you have used a unary operator '${token}' with nothing after it.`);
    const inner = parseNot();
    return (entry) => !inner(entry);
  }
  return parsePrimary();
}

function parsePrimary() {
  const token = expression[position];
  if (token === "(") {
    position++;
    if (expression[position] === ")")
      fail("invalid expression; empty parentheses are not allowed.");
    const inner = parseList();
    if (expression[position] !== ")")
      fail("invalid expression; I was expecting to find a ')' somewhere but did not see one.");
    position++;
    return inner;
  }
  if (token === ")") fail("invalid expression; you have too many ')'");
  if (["-o", "-or", "-a", "-and", ","].includes(token))
    fail(`invalid expression; you have used a binary operator '${token}' with nothing before it.`);
  if (!token.startsWith("-") || token.length === 1)
    fail(`paths must precede expression: '${token}'`);
  position++;
  const primary = PRIMARIES[token];
  if (!primary) fail(`unknown predicate '${token}'`);
  return primary(token);
}

let test = always;
if (expression.length > 0) {
  test = parseList();
  if (position < expression.length) fail("invalid expression; you have too many ')'");
}
// With no action, -print applies to whatever the expression accepts.
const evaluate = hasAction
  ? test
  : (entry) => {
      if (test(entry)) emit(`${entry.path}\n`);
    };

// ---------------------------------------------------------------- traversal

/** The name -name matches: the last component, ignoring trailing slashes. */
function baseName(path) {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return path === "" ? "" : "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function visit(path, name, depth, stat) {
  const entry = { path, name, depth, stat };
  const matches = depth >= options.mindepth;
  pruned = false;
  if (matches && !options.depthFirst) evaluate(entry);
  if (stat.isDirectory() && !pruned && depth < options.maxdepth) {
    let names = [];
    try {
      // Sorted by name so the output is the same on every run and file system;
      // GNU find uses the directory's own order.
      names = readdirSync(path).sort();
    } catch (error) {
      warn(`'${path}': ${reason(error)}`);
    }
    for (const child of names) {
      const childPath = path.endsWith("/") ? `${path}${child}` : `${path}/${child}`;
      let childStat;
      try {
        childStat = lstatSync(childPath);
      } catch (error) {
        warn(`'${childPath}': ${reason(error)}`);
        continue;
      }
      visit(childPath, child, depth + 1, childStat);
    }
  }
  if (matches && options.depthFirst) evaluate(entry);
}

try {
  for (const start of startingPoints) {
    let stat;
    try {
      stat = lstatSync(start);
    } catch (error) {
      warn(`'${start}': ${reason(error)}`);
      continue;
    }
    visit(start, baseName(start), 0, stat);
  }
} catch (error) {
  if (error !== QUIT) throw error;
}
// Pending `-exec ... +` batches run even after -quit, as in GNU find.
for (const batch of batches) runBatch(batch);
flush();
exit(exitStatus);
