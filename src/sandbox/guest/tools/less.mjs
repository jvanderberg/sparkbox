// A pager for the Sparkbox terminal: `less` and `more`.
//
// Reads files or stdin, and when stdout is the terminal shows them a screen
// at a time on the alternate screen. Keys: space/f/PgDn and b/PgUp page,
// j/k/arrows/Enter scroll a line, d/u half a page, g/G top and bottom,
// /text and ?text search, n/N repeat, q quits. When stdout is not a terminal
// it copies its input, as less does; so does `cmd | less` (see below).
import { readFileSync } from "node:fs";
import { err, exit, isTerminal, out, program, readStdin } from "./io.mjs";

const options = { lineNumbers: false, chop: false, quitIfOneScreen: program === "more" };
const files = [];
let endOfOptions = false;
for (const arg of process.argv.slice(2)) {
  if (endOfOptions || !arg.startsWith("-") || arg === "-") files.push(arg);
  else if (arg === "--") endOfOptions = true;
  else
    for (const flag of arg.slice(1)) {
      if (flag === "N") options.lineNumbers = true;
      else if (flag === "S") options.chop = true;
      else if (flag === "F") options.quitIfOneScreen = true;
      // -R, -X, -K and the like change nothing here: colours always pass through.
    }
}

let text = "";
let failed = false;
if (!files.length) text = readStdin().toString("utf8");
else
  for (const file of files) {
    try {
      const content = file === "-" ? readStdin() : readFileSync(file);
      if (files.length > 1) text += `::::::::::::::\n${file}\n::::::::::::::\n`;
      text += content.toString("utf8");
    } catch (error) {
      failed = true;
      err(
        `${program}: ${file}: ${error?.code === "ENOENT" ? "No such file or directory" : error?.code === "EISDIR" ? "is a directory" : error?.message}\n`,
      );
    }
  }

if (!isTerminal) {
  out(text);
  exit(failed ? 1 : 0);
}

// Keys come from stdin. With stdin a pipe (`git log | less`) this runtime
// offers no way to read the terminal, so the input is printed instead.
const input = process.stdin;
try {
  if (!input.isTTY) throw new Error("stdin is not the terminal");
  input.setRawMode(true);
} catch {
  out(text);
  exit(failed ? 1 : 0);
}

const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
if (!text) lines.length = 0;

// Colour codes pass through; every other control sequence is dropped so the
// screen arithmetic holds. Tabs become spaces.
const colourCode = "\x1b\\[[0-9;]*m";
const sgr = new RegExp(colourCode, "y");
function cells(line) {
  const parts = [];
  let column = 0;
  for (let index = 0; index < line.length; ) {
    sgr.lastIndex = index;
    const colour = sgr.exec(line);
    if (colour) {
      parts.push({ code: colour[0] });
      index = sgr.lastIndex;
      continue;
    }
    const char = line[index++];
    if (char === "\t") {
      const width = 8 - (column % 8);
      for (let n = 0; n < width; n++) parts.push({ char: " " });
      column += width;
    } else if (char === "\x1b" || char < " " || char === "\x7f") {
      // Skip a non-colour escape sequence or control character.
      if (char === "\x1b" && line[index] === "[") {
        index++;
        while (index < line.length && !/[@-~]/.test(line[index])) index++;
        index++;
      }
    } else {
      parts.push({ char });
      column++;
    }
  }
  return parts;
}

/** The screen rows a line takes: wrapped to the width, or chopped with -S. */
function rows(line, width) {
  const result = [];
  let row = "";
  let used = 0;
  let colours = "";
  for (const part of cells(line)) {
    if (part.code) {
      row += part.code;
      colours = part.code === "\x1b[0m" || part.code === "\x1b[m" ? "" : colours + part.code;
      continue;
    }
    if (used === width) {
      if (options.chop) break;
      result.push(`${row}\x1b[0m`);
      row = colours;
      used = 0;
    }
    row += part.char;
    used++;
  }
  result.push(`${row}\x1b[0m`);
  return result;
}

let screen = [];
let lineOfRow = [];
function layout() {
  const width = Math.max(10, (process.stdout.columns || 80) - (options.lineNumbers ? 8 : 0));
  screen = [];
  lineOfRow = [];
  lines.forEach((line, index) => {
    for (const row of rows(line, width)) {
      screen.push(
        options.lineNumbers ? `\x1b[2m${String(index + 1).padStart(7)}\x1b[0m ${row}` : row,
      );
      lineOfRow.push(index);
    }
  });
}
layout();

const height = () => Math.max(2, (process.stdout.rows || 24) - 1);
if (options.quitIfOneScreen && screen.length <= height()) {
  out(text);
  exit(failed ? 1 : 0);
}

let top = 0;
let prompt = "";
let message = "";
let lastSearch = null;
const maxTop = () => Math.max(0, screen.length - height());

function render() {
  top = Math.min(Math.max(0, top), maxTop());
  let frame = "\x1b[H";
  for (let row = 0; row < height(); row++)
    frame += `${screen[top + row] ?? "\x1b[2m~\x1b[0m"}\x1b[K\r\n`;
  const status =
    prompt ||
    message ||
    (top >= maxTop()
      ? "(END)"
      : files.length === 1
        ? `${files[0]} ${Math.round(((top + height()) / screen.length) * 100)}%`
        : ":");
  frame += `\x1b[7m${status}\x1b[0m\x1b[K`;
  out(frame);
}

function search(pattern, backwards, from) {
  const needle = pattern.toLowerCase();
  const sensitive = needle !== pattern;
  const matches = (line) => (sensitive ? line : line.toLowerCase()).includes(pattern);
  const start = lineOfRow[from] ?? 0;
  for (let step = 1; step <= lines.length; step++) {
    const index = backwards
      ? (start - step + lines.length) % lines.length
      : (start + step) % lines.length;
    if (matches(lines[index].replace(new RegExp(colourCode, "g"), ""))) {
      top = lineOfRow.indexOf(index);
      return;
    }
  }
  message = "Pattern not found";
}

function quit(code = 0) {
  out("\x1b[?25h\x1b[?1049l");
  input.setRawMode(false);
  exit(failed ? 1 : code);
}

out("\x1b[?1049h\x1b[?25l");
render();
process.stdout.on("resize", () => {
  const line = lineOfRow[top] ?? 0;
  layout();
  top = lineOfRow.indexOf(line);
  render();
});

const keys = {
  q: () => quit(),
  Q: () => quit(),
  "\x03": () => quit(130),
  j: () => top++,
  e: () => top++,
  "\r": () => top++,
  "\x1b[B": () => top++,
  k: () => top--,
  y: () => top--,
  "\x1b[A": () => top--,
  " ": () => (top += height()),
  f: () => (top += height()),
  "\x06": () => (top += height()),
  "\x1b[6~": () => (top += height()),
  b: () => (top -= height()),
  "\x02": () => (top -= height()),
  "\x1b[5~": () => (top -= height()),
  d: () => (top += Math.floor(height() / 2)),
  "\x04": () => (top += Math.floor(height() / 2)),
  u: () => (top -= Math.floor(height() / 2)),
  "\x15": () => (top -= Math.floor(height() / 2)),
  g: () => (top = 0),
  "<": () => (top = 0),
  "\x1b[H": () => (top = 0),
  G: () => (top = maxTop()),
  ">": () => (top = maxTop()),
  "\x1b[F": () => (top = maxTop()),
  n: () => lastSearch && search(lastSearch.pattern, lastSearch.backwards, top),
  N: () => lastSearch && search(lastSearch.pattern, !lastSearch.backwards, top),
};

/** One chunk can hold several keys when typing is fast or text is pasted. */
function splitKeys(chunk) {
  const found = [];
  for (let index = 0; index < chunk.length; ) {
    if (chunk[index] === "\x1b" && chunk[index + 1] === "[") {
      let end = index + 2;
      while (end < chunk.length && !/[@-~]/.test(chunk[end])) end++;
      found.push(chunk.slice(index, end + 1));
      index = end + 1;
    } else found.push(chunk[index++]);
  }
  return found;
}

input.on("data", (chunk) => {
  for (const key of splitKeys(chunk.toString("utf8"))) press(key);
  render();
});

function press(key) {
  message = "";
  if (prompt) {
    // Typing a search pattern after / or ?.
    if (key === "\r") {
      const pattern = prompt.slice(1);
      const backwards = prompt[0] === "?";
      prompt = "";
      if (pattern) lastSearch = { pattern, backwards };
      if (lastSearch) search(lastSearch.pattern, lastSearch.backwards, top);
    } else if (key === "\x1b" || key === "\x03") prompt = "";
    else if (key === "\x7f" || key === "\b") prompt = prompt.length > 1 ? prompt.slice(0, -1) : "";
    else if (key >= " ") prompt += key;
  } else if (key === "/" || key === "?") prompt = key;
  else keys[key]?.();
}
