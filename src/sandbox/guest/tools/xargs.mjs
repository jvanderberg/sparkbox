// xargs for the Sparkbox sandbox: a subset of GNU xargs, written in Node
// because the sandbox has no xargs binary. Commands run one at a time.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { err, exit, fail, out, readStdin } from "./io.mjs";

const USAGE = `Usage: xargs [OPTION]... COMMAND [INITIAL-ARGS]...

  -0, --null                 items are separated by NUL, not whitespace
  -a, --arg-file=FILE        read items from FILE instead of standard input
  -d, --delimiter=CHAR       items are separated by CHAR (\\n, \\t, \\0, \\xHH, \\NNN)
  -I R, --replace[=R]        replace R (-i: {}) in INITIAL-ARGS, one command per line
  -L, --max-lines=N          at most N non-blank input lines per command
  -n, --max-args=N           at most N arguments per command
  -r, --no-run-if-empty      do not run COMMAND when there is no input
  -t, --verbose              print each command to standard error first
  -P, -s, -x                 accepted and ignored
`;

// Arguments per command line when no -n or -L limits them, roughly GNU's default.
const MAX_COMMAND_CHARS = 128 * 1024;

const settings = {
  delimiter: null, // null: blanks and newlines, with quotes and backslashes
  maxArgs: 0,
  maxLines: 0,
  replace: null,
  noRunIfEmpty: false,
  verbose: false,
  argFile: null,
};

function positiveNumber(option, value) {
  if (!/^\d+$/.test(value)) fail(`invalid number "${value}" for -${option} option`);
  const n = Number(value);
  if (n < 1) fail(`value ${value} for -${option} option should be >= 1`);
  return n;
}

/** The single character a -d argument names: a character or a backslash escape. */
function parseDelimiter(value) {
  if (value.length === 1) return value;
  const escapes = { n: "\n", t: "\t", r: "\r", 0: "\0", "\\": "\\", a: "\x07", b: "\b", f: "\f" };
  let match = /^\\x([0-9a-fA-F]{1,2})$/.exec(value);
  if (match) return String.fromCharCode(Number.parseInt(match[1], 16));
  match = /^\\([0-7]{1,3})$/.exec(value);
  if (match) return String.fromCharCode(Number.parseInt(match[1], 8));
  if (value.length === 2 && value[0] === "\\" && value[1] in escapes) return escapes[value[1]];
  return fail(
    `invalid input delimiter specification ${value}: the delimiter must be either a single character or an escape sequence starting with \\.`,
  );
}

function setOption(option, value) {
  switch (option) {
    case "0":
      settings.delimiter = "\0";
      break;
    case "d":
      settings.delimiter = parseDelimiter(value);
      break;
    case "a":
      settings.argFile = value;
      break;
    case "n":
      settings.maxArgs = positiveNumber(option, value);
      settings.maxLines = 0;
      break;
    case "L":
      settings.maxLines = positiveNumber(option, value);
      settings.maxArgs = 0;
      break;
    case "I":
      settings.replace = value;
      break;
    case "r":
      settings.noRunIfEmpty = true;
      break;
    case "t":
      settings.verbose = true;
      break;
    // Accepted for compatibility: commands always run one at a time (-P), the
    // command-line limit is fixed (-s), and -x has nothing to enforce.
    case "P":
    case "s":
    case "x":
      break;
  }
}

const SHORT_WITH_VALUE = new Set(["a", "d", "n", "L", "I", "P", "s"]);
const SHORT_FLAGS = new Set(["0", "r", "t", "x"]);
const LONG = {
  null: ["0", "none"],
  "arg-file": ["a", "required"],
  delimiter: ["d", "required"],
  "max-args": ["n", "required"],
  "max-lines": ["L", "required"],
  replace: ["I", "optional"],
  "no-run-if-empty": ["r", "none"],
  verbose: ["t", "none"],
  "max-procs": ["P", "required"],
  "max-chars": ["s", "required"],
  exit: ["x", "none"],
};

// Options come first; the first other argument starts the command.
const args = process.argv.slice(2);
let index = 0;
for (; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--") {
    index++;
    break;
  }
  if (arg === "--help") {
    out(USAGE);
    exit(0);
  }
  if (arg.startsWith("--")) {
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    const long = LONG[name];
    if (!long) fail(`unrecognized option '${arg}'\n${USAGE}`);
    const [option, kind] = long;
    let value = inline;
    if (kind === "required" && value === undefined) {
      if (index + 1 >= args.length) fail(`option '--${name}' requires an argument`);
      value = args[++index];
    }
    setOption(option, kind === "optional" ? (value ?? "{}") : value);
    continue;
  }
  if (!arg.startsWith("-") || arg === "-") break;
  for (let j = 1; j < arg.length; j++) {
    const option = arg[j];
    if (option === "i") {
      // -i[R] is the old spelling of -I, with {} as the default.
      setOption("I", arg.slice(j + 1) || "{}");
      break;
    }
    if (SHORT_WITH_VALUE.has(option)) {
      let value = arg.slice(j + 1);
      if (value === "") {
        if (index + 1 >= args.length) fail(`option requires an argument -- '${option}'`);
        value = args[++index];
      }
      setOption(option, value);
      break;
    }
    if (!SHORT_FLAGS.has(option)) fail(`invalid option -- '${option}'\n${USAGE}`);
    setOption(option, "");
  }
}
const initialArgs = index < args.length ? args.slice(index) : ["echo"];

// ---------------------------------------------------------------- input

const isBlank = (c) => c === " " || c === "\t";

/**
 * Split input the default way: arguments are separated by blanks and newlines;
 * single and double quotes group (without escapes inside, and not across a
 * newline) and a backslash makes the next character literal. Returns the
 * logical lines, each a list of arguments. A line ending in a blank continues
 * on the next one (this matters for -L). With `wholeLines` (-I), each line is
 * one argument with its leading blanks removed.
 */
function splitQuoted(text, wholeLines) {
  const lines = [];
  let line = [];
  let word = "";
  let inWord = false; // set by a quote too, so '' is an empty argument
  let quote = "";
  let previous = "";
  const endWord = () => {
    if (inWord) line.push(word);
    word = "";
    inWord = false;
  };
  const endLine = () => {
    endWord();
    if (line.length > 0) lines.push(line);
    line = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\n")
        fail(
          `unmatched ${quote === "'" ? "single" : "double"} quote; by default quotes are special to xargs unless you use the -0 option`,
        );
      else word += c;
    } else if (c === "\n") {
      if (wholeLines || !isBlank(previous)) endLine();
      else endWord();
    } else if (isBlank(c) && (!wholeLines || !inWord)) {
      if (!wholeLines) endWord();
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
      previous = "\\";
      continue;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else {
      word += c;
      inWord = true;
    }
    previous = c;
  }
  if (quote)
    fail(
      `unmatched ${quote === "'" ? "single" : "double"} quote; by default quotes are special to xargs unless you use the -0 option`,
    );
  endLine();
  return lines;
}

let input;
if (settings.argFile === null) input = readStdin();
else {
  try {
    input = readFileSync(settings.argFile);
  } catch (error) {
    fail(
      `${settings.argFile}: ${error.code === "ENOENT" ? "No such file or directory" : error.message}`,
    );
  }
}
const text = input.toString("utf8");

let lines;
if (settings.delimiter === null) lines = splitQuoted(text, settings.replace !== null);
else {
  // With -0 or -d every character is literal and each item counts as a line.
  const items = text.split(settings.delimiter);
  if (items.at(-1) === "") items.pop();
  lines = items.map((item) => [item]);
}

// ---------------------------------------------------------------- commands

const commands = [];
if (settings.replace !== null) {
  const replace = settings.replace;
  for (const [item] of lines)
    commands.push(initialArgs.map((arg) => arg.split(replace).join(item)));
} else if (settings.maxLines > 0) {
  for (let i = 0; i < lines.length; i += settings.maxLines)
    commands.push([...initialArgs, ...lines.slice(i, i + settings.maxLines).flat()]);
} else {
  const baseLength = initialArgs.reduce((sum, arg) => sum + arg.length + 1, 0);
  let current = [];
  let length = baseLength;
  for (const arg of lines.flat()) {
    const full = settings.maxArgs > 0 && current.length >= settings.maxArgs;
    const tooLong = current.length > 0 && length + arg.length + 1 > MAX_COMMAND_CHARS;
    if (full || tooLong) {
      commands.push([...initialArgs, ...current]);
      current = [];
      length = baseLength;
    }
    current.push(arg);
    length += arg.length + 1;
  }
  if (current.length > 0) commands.push([...initialArgs, ...current]);
}
// GNU xargs runs the command once on empty input unless -r (or -I) is given.
if (commands.length === 0 && !settings.noRunIfEmpty && settings.replace === null)
  commands.push(initialArgs);

let exitStatus = 0;
for (const argv of commands) {
  const [command, ...rest] = argv;
  if (settings.verbose) err(`${argv.join(" ")}\n`);
  // stdin is ours (already read), so commands get none, as GNU gives them /dev/null.
  const result = spawnSync(command, rest, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      // The sandbox may have echo only as a bash builtin; xargs' default command must still work.
      if (command === "echo") {
        out(`${rest.join(" ")}\n`);
        continue;
      }
      fail(`${command}: No such file or directory`, 127);
    }
    fail(`${command}: ${result.error.message}`, 126);
  }
  if (result.signal)
    fail(
      `${command}: terminated by signal ${constants.signals[result.signal] ?? result.signal}`,
      125,
    );
  if (result.status === 255) fail(`${command}: exited with status 255; aborting`, 124);
  if (result.status !== 0) exitStatus = 123;
}
exit(exitStatus);
