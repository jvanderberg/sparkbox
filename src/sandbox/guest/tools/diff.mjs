// diff for the Sparkbox sandbox: a subset of GNU diff.
//
// Lines are compared with Myers' O(ND) algorithm (the linear-space "middle
// snake" variant), then GNU's shift_boundaries pass slides each change to
// where GNU would put it, so the hunks usually match GNU diff line for line.
//
// Supported: normal and unified (-u, -U N) output, -q, -s, -r, -N, -i, -w,
// -b, -B (approximate), -a, -x PATTERN, --label, --color.
// Not supported: context (-c) and side-by-side (-y) output, ed scripts, -p,
// -I REGEXP, --strip-trailing-cr, --no-dereference.
import { fstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { err, exit, isTerminal, out, readStdin } from "./io.mjs";

const help = `Usage: diff [OPTION]... FILE1 FILE2
Compare files line by line. FILE may be '-' for standard input.

  -q, --brief                   report only when files differ
  -s, --report-identical-files  report when two files are the same
  -u, -U NUM, --unified[=NUM]   output NUM (default 3) lines of unified context
      --normal                  output a normal diff (the default)
  -r, --recursive               recursively compare any subdirectories found
  -N, --new-file                treat absent files as empty
  -x, --exclude=PAT             exclude files whose name matches PAT
  -i, --ignore-case             ignore case differences in file contents
  -b, --ignore-space-change     ignore changes in the amount of white space
  -w, --ignore-all-space        ignore all white space
  -B, --ignore-blank-lines      ignore changes whose lines are all blank
  -a, --text                    treat all files as text
      --label LABEL             use LABEL instead of the file name and time
      --color[=WHEN]            colorize the output; WHEN is never, always or auto

Exit status is 0 if inputs are the same, 1 if different, 2 if trouble.
`;

function usageError(message) {
  err(`diff: ${message}\ndiff: Try 'diff --help' for more information.\n`);
  exit(2);
}

// ---------------------------------------------------------------- options

const opt = {
  unified: false,
  context: 3,
  brief: false,
  same: false,
  recursive: false,
  newFile: false,
  icase: false,
  allSpace: false,
  spaceChange: false,
  blank: false,
  text: false,
  color: "never",
  labels: [],
  exclude: [],
};
// The options as typed, for the `diff -ru a/x b/x` lines of directory diffs.
const switches = [];
const operands = [];

function contextLength(value) {
  if (!/^\d+$/.test(value)) usageError(`invalid context length '${value}'`);
  return Number(value);
}

function colorWhen(value) {
  if (!["never", "always", "auto"].includes(value))
    usageError(`invalid argument '${value}' for '--color'`);
  return value;
}

const args = process.argv.slice(2);
for (let k = 0; k < args.length; k++) {
  const arg = args[k];
  if (arg === "--") {
    operands.push(...args.slice(k + 1));
    break;
  }
  if (arg === "-" || !arg.startsWith("-")) {
    operands.push(arg);
    continue;
  }
  switches.push(arg);
  const next = (name) => {
    if (k + 1 >= args.length) usageError(`option requires an argument -- '${name}'`);
    switches.push(args[k + 1]);
    return args[++k];
  };
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    const value = () => inline ?? next(name);
    const flags = {
      brief: () => {
        opt.brief = true;
      },
      "report-identical-files": () => {
        opt.same = true;
      },
      recursive: () => {
        opt.recursive = true;
      },
      "new-file": () => {
        opt.newFile = true;
      },
      "ignore-case": () => {
        opt.icase = true;
      },
      "ignore-all-space": () => {
        opt.allSpace = true;
      },
      "ignore-space-change": () => {
        opt.spaceChange = true;
      },
      "ignore-blank-lines": () => {
        opt.blank = true;
      },
      text: () => {
        opt.text = true;
      },
      normal: () => {
        opt.unified = false;
      },
      unified: () => {
        opt.unified = true;
        if (inline !== undefined) opt.context = contextLength(inline);
      },
      color: () => {
        opt.color = inline === undefined ? "auto" : colorWhen(inline);
      },
      label: () => {
        opt.labels.push(value());
      },
      exclude: () => {
        opt.exclude.push(globRegExp(value()));
      },
      help: () => {
        out(help);
        exit(0);
      },
      version: () => {
        out("diff (Sparkbox) 1.0 - a subset of GNU diffutils\n");
        exit(0);
      },
    };
    const handler = Object.hasOwn(flags, name) ? flags[name] : undefined;
    if (!handler) usageError(`unrecognized option '${arg}'`);
    handler();
    continue;
  }
  for (let c = 1; c < arg.length; c++) {
    const letter = arg[c];
    // An option with an argument takes the rest of the cluster, or the next word.
    const value = () => {
      const rest = arg.slice(c + 1);
      c = arg.length;
      return rest || next(letter);
    };
    switch (letter) {
      case "u":
        opt.unified = true;
        break;
      case "U":
        opt.unified = true;
        opt.context = contextLength(value());
        break;
      case "q":
        opt.brief = true;
        break;
      case "s":
        opt.same = true;
        break;
      case "r":
        opt.recursive = true;
        break;
      case "N":
        opt.newFile = true;
        break;
      case "i":
        opt.icase = true;
        break;
      case "w":
        opt.allSpace = true;
        break;
      case "b":
        opt.spaceChange = true;
        break;
      case "B":
        opt.blank = true;
        break;
      case "a":
        opt.text = true;
        break;
      case "x":
        opt.exclude.push(globRegExp(value()));
        break;
      case "c":
      case "C":
      case "y":
        usageError(`option -${letter} is not supported in Sparkbox; use -u`);
        break;
      default:
        usageError(`invalid option -- '${letter}'`);
    }
  }
}

if (operands.length === 0) usageError("missing operand after 'diff'");
if (operands.length === 1) usageError(`missing operand after '${operands[0]}'`);
if (operands.length > 2) usageError(`extra operand '${operands[2]}'`);

const useColor = opt.color === "always" || (opt.color === "auto" && isTerminal);
const ignoreSpace = opt.allSpace || opt.spaceChange;
const ignoring = ignoreSpace || opt.icase || opt.blank;

// ---------------------------------------------------------------- output

// File contents are handled as latin1 strings, one character per byte, so
// output reproduces the input bytes exactly whatever their encoding.
const asBytes = (text) => Buffer.from(text).toString("latin1");

let pending = [];
let pendingSize = 0;
function emit(text) {
  pending.push(text);
  pendingSize += text.length;
  if (pendingSize > 65536) flush();
}
function flush() {
  if (pending.length === 0) return;
  out(Buffer.from(pending.join(""), "latin1"));
  pending = [];
  pendingSize = 0;
}
function complain(message) {
  flush();
  err(`diff: ${message}\n`);
}

const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

function reason(error) {
  const known = {
    ENOENT: "No such file or directory",
    EACCES: "Permission denied",
    ENOTDIR: "Not a directory",
    EISDIR: "Is a directory",
    ELOOP: "Too many levels of symbolic links",
  };
  return known[error?.code] ?? error?.message ?? String(error);
}

// ---------------------------------------------------------------- the diff

// Mark changed lines: ca[i + 1] for line i of a, cb[j + 1] for line j of b.
// Index 0 and the last index are always-zero sentinels (as in GNU's arrays).
function compareSeq(a, aLo, aHi, b, bLo, bHi, ca, cb) {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    aLo++;
    bLo++;
  }
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
  }
  if (aLo === aHi || bLo === bHi) {
    for (let i = aLo; i < aHi; i++) ca[i + 1] = 1;
    for (let j = bLo; j < bHi; j++) cb[j + 1] = 1;
    return;
  }
  const split = middleSnake(a, aLo, aHi, b, bLo, bHi);
  if (!split) {
    for (let i = aLo; i < aHi; i++) ca[i + 1] = 1;
    for (let j = bLo; j < bHi; j++) cb[j + 1] = 1;
    return;
  }
  compareSeq(a, aLo, split[0], b, bLo, split[1], ca, cb);
  compareSeq(a, split[0], aHi, b, split[1], bHi, ca, cb);
}

// Myers' bisection: run the forward and reverse searches until they overlap
// and return that point, which lies on a shortest edit path. Both ranges are
// non-empty and share no common prefix or suffix, so the point is interior.
function middleSnake(a, aLo, aHi, b, bLo, bHi) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const size = 2 * maxD + 2;
  const forward = new Int32Array(size).fill(-1);
  const reverse = new Int32Array(size).fill(-1);
  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;
  const delta = n - m;
  // With an odd delta the paths meet during a forward step, else a reverse one.
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = offset + k1;
      let x1 =
        k1 === -d || (k1 !== d && forward[k1o - 1] < forward[k1o + 1])
          ? forward[k1o + 1]
          : forward[k1o - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++;
        y1++;
      }
      forward[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = offset + delta - k1;
        if (k2o >= 0 && k2o < size && reverse[k2o] !== -1 && x1 >= n - reverse[k2o])
          return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = offset + k2;
      let x2 =
        k2 === -d || (k2 !== d && reverse[k2o - 1] < reverse[k2o + 1])
          ? reverse[k2o + 1]
          : reverse[k2o - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
        x2++;
        y2++;
      }
      reverse[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = offset + delta - k2;
        if (k1o >= 0 && k1o < size && forward[k1o] !== -1) {
          const x1 = forward[k1o];
          const y1 = x1 - (k1o - offset);
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}

// GNU's shift_boundaries: slide each run of changes in `c` down as far as
// equal lines allow (merging with later runs), then back up to line up with
// a run of changes in the other file. Equal lines on both sides mean the
// result is still a correct diff; it just reads the way GNU's does.
function shiftBoundaries(c, other, equivs, end) {
  const changed = (i) => c[i + 1];
  const otherChanged = (j) => other[j + 1];
  let i = 0;
  let j = 0;
  for (;;) {
    // Find the next run of changes, tracking the matching point in the other file.
    while (i < end && !changed(i)) {
      while (otherChanged(j)) j++;
      j++;
      i++;
    }
    if (i === end) break;
    let start = i;
    i++;
    while (changed(i)) i++;
    while (otherChanged(j)) j++;
    let runLength;
    let corresponding;
    do {
      runLength = i - start;
      // Move the run back while the line before it equals its last line.
      while (start && equivs[start - 1] === equivs[i - 1]) {
        start--;
        c[start + 1] = 1;
        i--;
        c[i + 1] = 0;
        while (changed(start - 1)) start--;
        j--;
        while (otherChanged(j)) j--;
      }
      corresponding = otherChanged(j - 1) ? i : end;
      // Move it forward while its first line equals the line after it.
      while (i !== end && equivs[start] === equivs[i]) {
        c[start + 1] = 0;
        start++;
        c[i + 1] = 1;
        i++;
        while (changed(i)) i++;
        j++;
        while (otherChanged(j)) {
          corresponding = i;
          j++;
        }
      }
    } while (runLength !== i - start);
    // Then back to the last place it lined up with changes in the other file.
    while (corresponding < i) {
      start--;
      c[start + 1] = 1;
      i--;
      c[i + 1] = 0;
      j--;
      while (otherChanged(j)) j--;
    }
  }
}

function splitLines(text) {
  if (text === "") return { lines: [], incomplete: false };
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
    return { lines, incomplete: false };
  }
  return { lines, incomplete: true };
}

function normalize(line) {
  let key = line;
  if (opt.icase) key = key.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  if (opt.allSpace) key = key.replace(/[ \t\v\f\r]+/g, "");
  else if (opt.spaceChange) key = key.replace(/[ \t\v\f\r]+/g, " ").replace(/ $/, "");
  return key;
}

const isBlank = (line) => (ignoreSpace ? /^[ \t\v\f\r]*$/.test(line) : line === "");

/** The changes between two texts: [{ line0, line1, deleted, inserted, ignorable }]. */
function diffLines(A, B) {
  const ids = new Map();
  const encode = (file) => {
    const codes = new Int32Array(file.lines.length);
    file.lines.forEach((line, index) => {
      let key = normalize(line);
      // A last line without a newline differs from the same text with one,
      // unless white space is being ignored (the newline counts as space).
      if (file.incomplete && index === file.lines.length - 1 && !ignoreSpace) key += "\n";
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      codes[index] = id;
    });
    return codes;
  };
  const a = encode(A);
  const b = encode(B);
  const n = a.length;
  const m = b.length;
  const ca = new Uint8Array(n + 2);
  const cb = new Uint8Array(m + 2);
  compareSeq(a, 0, n, b, 0, m, ca, cb);
  shiftBoundaries(ca, cb, a, n);
  shiftBoundaries(cb, ca, b, m);

  const changes = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (ca[i + 1] || cb[j + 1]) {
      const line0 = i;
      const line1 = j;
      while (ca[i + 1]) i++;
      while (cb[j + 1]) j++;
      const deleted = i - line0;
      const inserted = j - line1;
      const ignorable =
        opt.blank &&
        A.lines.slice(line0, i).every(isBlank) &&
        B.lines.slice(line1, j).every(isBlank);
      changes.push({ line0, line1, deleted, inserted, ignorable });
    } else {
      i++;
      j++;
    }
  }
  return changes;
}

// ---------------------------------------------------------------- formats

const noNewline = "\\ No newline at end of file\n";

function emitLine(prefix, file, index, color) {
  const text = `${prefix}${file.lines[index]}`;
  emit(color ? `${paint(color, text)}\n` : `${text}\n`);
  if (file.incomplete && index === file.lines.length - 1) emit(noNewline);
}

function printNormal(A, B, changes) {
  // A range of lines first..last (1-based); an empty one prints the line before it.
  const range = (first, last) => (last > first ? `${first},${last}` : `${last}`);
  for (const change of changes) {
    if (change.ignorable) continue;
    const { line0, line1, deleted, inserted } = change;
    const command = deleted && inserted ? "c" : deleted ? "d" : "a";
    emit(
      `${paint("36", `${range(line0 + 1, line0 + deleted)}${command}${range(line1 + 1, line1 + inserted)}`)}\n`,
    );
    for (let i = line0; i < line0 + deleted; i++) emitLine("< ", A, i, "31");
    if (deleted && inserted) emit("---\n");
    for (let j = line1; j < line1 + inserted; j++) emitLine("> ", B, j, "32");
  }
}

function printUnified(A, B, changes, labelA, labelB) {
  const context = opt.context;
  // GNU's hunk ranges: `start,count`, `start` when count is 1, and for an
  // empty range the line before it with count 0.
  const range = (start, count) =>
    count === 0 ? `${start - 1},0` : count === 1 ? `${start}` : `${start},${count}`;
  emit(`${paint("1", `--- ${labelA}`)}\n`);
  emit(`${paint("1", `+++ ${labelB}`)}\n`);
  let k = 0;
  while (k < changes.length) {
    // Changes separated by at most 2 * context equal lines share a hunk.
    let last = k;
    while (
      last + 1 < changes.length &&
      changes[last + 1].line0 - (changes[last].line0 + changes[last].deleted) <= 2 * context
    )
      last++;
    const group = changes.slice(k, last + 1);
    k = last + 1;
    if (group.every((change) => change.ignorable)) continue;
    const first = group[0];
    const final = group[group.length - 1];
    const aStart = Math.max(0, first.line0 - context);
    const bStart = first.line1 - (first.line0 - aStart);
    const aEnd = Math.min(A.lines.length, final.line0 + final.deleted + context);
    const bEnd = final.line1 + final.inserted + (aEnd - (final.line0 + final.deleted));
    emit(
      `${paint("36", `@@ -${range(aStart + 1, aEnd - aStart)} +${range(bStart + 1, bEnd - bStart)} @@`)}\n`,
    );
    let i = aStart;
    for (const change of group) {
      for (; i < change.line0; i++) emitLine(" ", A, i);
      for (; i < change.line0 + change.deleted; i++) emitLine("-", A, i, "31");
      for (let j = change.line1; j < change.line1 + change.inserted; j++) emitLine("+", B, j, "32");
    }
    for (; i < aEnd; i++) emitLine(" ", A, i);
  }
}

// ---------------------------------------------------------------- files

// GNU's header time: local time with nanoseconds and a numeric zone.
function formatTime({ sec, ns }) {
  const date = new Date(sec * 1000);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const zone = -date.getTimezoneOffset();
  const sign = zone < 0 ? "-" : "+";
  const abs = Math.abs(zone);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(ns, 9)} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

function timeOf(stat) {
  if (typeof stat.mtimeNs === "bigint")
    return { sec: Number(stat.mtimeNs / 1000000000n), ns: Number(stat.mtimeNs % 1000000000n) };
  const sec = Math.floor(stat.mtimeMs / 1000);
  return { sec, ns: Math.min(999999999, Math.round((stat.mtimeMs - sec * 1000) * 1e6)) };
}

function fileTime(path) {
  try {
    return timeOf(statSync(path, { bigint: true }));
  } catch {
    return timeOf(statSync(path));
  }
}

const now = () => {
  const ms = Date.now();
  return { sec: Math.floor(ms / 1000), ns: (ms % 1000) * 1e6 };
};

// Standard input that is a regular file has a time; a pipe gets the current time.
function stdinTime() {
  try {
    const stat = fstatSync(0);
    return stat.isFile() ? timeOf(stat) : now();
  } catch {
    return now();
  }
}

let stdinBytes;
/** A side: { path, name, absent }. `absent` is a missing file under -N. */
function load(side) {
  if (side.absent) return { bytes: Buffer.alloc(0), time: { sec: 0, ns: 0 } };
  if (side.path === "-") {
    stdinBytes ??= readStdin();
    return { bytes: stdinBytes, time: stdinTime() };
  }
  return { bytes: readFileSync(side.path), time: fileTime(side.path) };
}

const isBinary = (bytes) => bytes.subarray(0, 8192).includes(0);

/** Compare two files and print the result; returns 0, 1 or 2. */
function compareFiles(sideA, sideB, inDirectory) {
  let a;
  let b;
  try {
    a = load(sideA);
  } catch (error) {
    complain(`${sideA.name}: ${reason(error)}`);
    return 2;
  }
  try {
    b = load(sideB);
  } catch (error) {
    complain(`${sideB.name}: ${reason(error)}`);
    return 2;
  }
  const nameA = asBytes(sideA.name);
  const nameB = asBytes(sideB.name);
  const identical = () => {
    if (opt.same) emit(`Files ${nameA} and ${nameB} are identical\n`);
    return 0;
  };
  const differ = () => {
    emit(`Files ${nameA} and ${nameB} differ\n`);
    return 1;
  };
  if (a.bytes.equals(b.bytes)) return identical();
  if (!opt.text && (isBinary(a.bytes) || isBinary(b.bytes))) {
    if (opt.brief) return differ();
    emit(`Binary files ${nameA} and ${nameB} differ\n`);
    return 1;
  }
  if (opt.brief && !ignoring) return differ();

  const A = splitLines(a.bytes.toString("latin1"));
  const B = splitLines(b.bytes.toString("latin1"));
  const changes = diffLines(A, B);
  if (!changes.some((change) => !change.ignorable)) return identical();
  if (opt.brief) return differ();

  if (inDirectory) emit(`${["diff", ...switches.map(asBytes), nameA, nameB].join(" ")}\n`);
  if (opt.unified) {
    const label = (index, name, time) =>
      opt.labels[index] !== undefined ? asBytes(opt.labels[index]) : `${name}\t${formatTime(time)}`;
    printUnified(A, B, changes, label(0, nameA, a.time), label(1, nameB, b.time));
  } else {
    printNormal(A, B, changes);
  }
  return 1;
}

// ---------------------------------------------------------------- directories

// A glob (`*`, `?`, `[...]`) as a regular expression for a whole file name.
function globRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[" && glob.indexOf("]", i + 2) > 0) {
      const close = glob.indexOf("]", i + 2);
      let set = glob.slice(i + 1, close);
      if (set.startsWith("!")) set = `^${set.slice(1)}`;
      source += `[${set.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else source += ch.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s");
}

const child = (dir, name) => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function kind(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return stat.size === 0 ? "regular empty file" : "regular file";
  if (stat.isSymbolicLink()) return "symbolic link";
  if (stat.isFIFO()) return "fifo";
  return "special file";
}

function listDir(dir, exists) {
  if (!exists) return [];
  return readdirSync(dir)
    .filter((name) => !opt.exclude.some((pattern) => pattern.test(name)))
    .sort(byName);
}

const byName = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** Compare two directories; under -N one of them may be absent. */
function compareDirs(dirA, dirB, existsA = true, existsB = true) {
  let names;
  try {
    names = new Set(listDir(dirA, existsA));
  } catch (error) {
    complain(`${dirA}: ${reason(error)}`);
    return 2;
  }
  try {
    for (const name of listDir(dirB, existsB)) names.add(name);
  } catch (error) {
    complain(`${dirB}: ${reason(error)}`);
    return 2;
  }
  let status = 0;
  for (const name of [...names].sort(byName)) {
    const pathA = child(dirA, name);
    const pathB = child(dirB, name);
    const statA = existsA ? statOrNull(pathA) : null;
    const statB = existsB ? statOrNull(pathB) : null;
    let result;
    if (!statA || !statB) {
      const present = statA ?? statB;
      if (opt.newFile && present.isDirectory() && opt.recursive) {
        result = compareDirs(pathA, pathB, Boolean(statA), Boolean(statB));
      } else if (opt.newFile && !present.isDirectory()) {
        result = compareFiles(
          { path: pathA, name: pathA, absent: !statA },
          { path: pathB, name: pathB, absent: !statB },
          true,
        );
      } else {
        emit(`Only in ${asBytes(statA ? dirA : dirB)}: ${asBytes(name)}\n`);
        result = 1;
      }
    } else if (statA.isDirectory() && statB.isDirectory()) {
      if (opt.recursive) result = compareDirs(pathA, pathB);
      else {
        emit(`Common subdirectories: ${asBytes(pathA)} and ${asBytes(pathB)}\n`);
        result = 0;
      }
    } else if (statA.isDirectory() || statB.isDirectory()) {
      emit(
        `File ${asBytes(pathA)} is a ${kind(statA)} while file ${asBytes(pathB)} is a ${kind(statB)}\n`,
      );
      result = 1;
    } else {
      result = compareFiles({ path: pathA, name: pathA }, { path: pathB, name: pathB }, true);
    }
    status = Math.max(status, result);
  }
  return status;
}

// ---------------------------------------------------------------- main

function main() {
  const [first, second] = operands;
  const statFirst = first === "-" ? "stdin" : statOrNull(first);
  const statSecond = second === "-" ? "stdin" : statOrNull(second);
  const isDir = (stat) => stat !== "stdin" && stat?.isDirectory();
  for (const [path, stat, other] of [
    [first, statFirst, statSecond],
    [second, statSecond, statFirst],
  ]) {
    if (stat) continue;
    // Under -N a missing file is empty, if the other operand exists and is a file.
    if (opt.newFile && other && !isDir(other)) continue;
    try {
      statSync(path);
    } catch (error) {
      complain(`${path}: ${reason(error)}`);
    }
    return 2;
  }
  if (isDir(statFirst) && isDir(statSecond)) return compareDirs(first, second);
  if (isDir(statFirst) || isDir(statSecond)) {
    if (first === "-" || second === "-") {
      complain("cannot compare '-' to a directory");
      return 2;
    }
    // FILE vs DIR compares FILE with DIR/basename(FILE).
    if (isDir(statFirst)) {
      const path = child(first, basename(second));
      return compareFiles({ path, name: path }, { path: second, name: second }, false);
    }
    const path = child(second, basename(first));
    return compareFiles({ path: first, name: first }, { path, name: path }, false);
  }
  return compareFiles(
    { path: first, name: first, absent: !statFirst },
    { path: second, name: second, absent: !statSecond },
    false,
  );
}

const status = main();
flush();
exit(status);
