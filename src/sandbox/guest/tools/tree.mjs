// tree for the Sparkbox sandbox: list directories as an indented tree.
//
// Supported: -a, -d, -L N, -I PATTERN, -P PATTERN, -f, -s, -h, --dirsfirst,
// --noreport, -C, -n. Entries are sorted by name in plain code-point order
// (tree in the C locale); there is no locale-aware collation.
//
// Projects carry huge node_modules trees (and .git, with -a), so those
// directories are listed and counted but not descended into, shown as
// `node_modules/ …`, unless named on the command line.
import { lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { err, exit, isTerminal, out } from "./io.mjs";

const help = `usage: tree [-adfhsCn] [-L level] [-I pattern] [-P pattern] [--dirsfirst]
       [--noreport] [--] [directory ...]
  -a            All files are listed (including dotfiles).
  -d            List directories only.
  -L level      Descend only level directories deep.
  -I pattern    Do not list files that match the pattern (a|b for several).
  -P pattern    List only those files that match the pattern.
  -f            Print the full path prefix for each file.
  -s            Print the size in bytes of each file.
  -h            Print the size in a more human readable way.
  --dirsfirst   List directories before files.
  --noreport    Turn off the file/directory count at the end of the tree.
  -C            Turn colorization on always.
  -n            Turn colorization off always.
node_modules and .git are not descended into unless named as a directory.
`;

function usageError(message) {
  err(`tree: ${message}\n${help}`);
  exit(1);
}

// tree's patterns: globs (`*`, `?`, `[...]`) separated by `|`, matched
// against the whole file name.
function patternRegExp(pattern) {
  const alternatives = pattern.split("|").map((glob) => {
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
    return source;
  });
  return new RegExp(`^(?:${alternatives.join("|")})$`, "s");
}

const opt = {
  all: false,
  dirsOnly: false,
  level: Infinity,
  ignore: [],
  only: [],
  fullPath: false,
  size: false,
  human: false,
  dirsFirst: false,
  report: true,
  color: isTerminal,
};
const roots = [];

const args = process.argv.slice(2);
for (let k = 0; k < args.length; k++) {
  const arg = args[k];
  if (arg === "--") {
    roots.push(...args.slice(k + 1));
    break;
  }
  if (arg === "-" || !arg.startsWith("-")) {
    roots.push(arg);
    continue;
  }
  if (arg.startsWith("--")) {
    if (arg === "--dirsfirst") opt.dirsFirst = true;
    else if (arg === "--noreport") opt.report = false;
    else if (arg === "--help") {
      out(help);
      exit(0);
    } else if (arg === "--version") {
      out("tree (Sparkbox) 1.0\n");
      exit(0);
    } else usageError(`Invalid argument '${arg}'.`);
    continue;
  }
  for (let c = 1; c < arg.length; c++) {
    const letter = arg[c];
    // -L, -I and -P take the rest of the word, or the next word.
    const value = () => {
      const rest = arg.slice(c + 1);
      c = arg.length;
      if (rest) return rest;
      if (k + 1 >= args.length) usageError(`Missing argument to -${letter} option.`);
      return args[++k];
    };
    switch (letter) {
      case "a":
        opt.all = true;
        break;
      case "d":
        opt.dirsOnly = true;
        break;
      case "L": {
        const level = value();
        if (!/^\d+$/.test(level) || Number(level) < 1)
          usageError("Invalid level, must be greater than 0.");
        opt.level = Number(level);
        break;
      }
      case "I":
        opt.ignore.push(patternRegExp(value()));
        break;
      case "P":
        opt.only.push(patternRegExp(value()));
        break;
      case "f":
        opt.fullPath = true;
        break;
      case "s":
        opt.size = true;
        break;
      case "h":
        opt.size = true;
        opt.human = true;
        break;
      case "C":
        opt.color = true;
        break;
      case "n":
        opt.color = false;
        break;
      default:
        usageError(`Invalid argument -${letter}.`);
    }
  }
}
if (roots.length === 0) roots.push(".");

const notDescended = new Set(["node_modules", ".git"]);

let pending = [];
function emit(line) {
  pending.push(line);
  if (pending.length >= 512) flush();
}
function flush() {
  if (pending.length === 0) return;
  out(`${pending.join("\n")}\n`);
  pending = [];
}

const paint = (code, text) => (opt.color ? `\x1b[${code}m${text}\x1b[0m` : text);

// tree's size field: `[       1234]` with -s, `[1.2K]` with -h.
function sizeField(bytes) {
  if (!opt.size) return "";
  if (!opt.human) return `[${String(bytes).padStart(11)}]  `;
  if (bytes < 1024) return `[${String(bytes).padStart(4)}]  `;
  const units = "KMGTPEZY";
  let unit = 0;
  let value = bytes / 1024;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const number = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `[${number.padStart(3)}${units[unit]}]  `;
}

/** An entry: its name, lstat, and whether it is (or links to) a directory. */
function describe(dir, name) {
  const path = dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { name, path, stat: null, isDir: false, link: null };
  }
  let link = null;
  let isDir = stat.isDirectory();
  if (stat.isSymbolicLink()) {
    try {
      link = readlinkSync(path);
    } catch {
      link = "?";
    }
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
  }
  return { name, path, stat, isDir, link };
}

const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);

function children(dir) {
  const entries = readdirSync(dir)
    .filter((name) => opt.all || !name.startsWith("."))
    .filter((name) => !opt.ignore.some((pattern) => pattern.test(name)))
    .map((name) => describe(dir, name))
    .filter((entry) => (opt.dirsOnly ? entry.isDir : true))
    // -P only filters files; directories are always shown.
    .filter(
      (entry) => entry.isDir || opt.only.length === 0 || opt.only.some((p) => p.test(entry.name)),
    );
  entries.sort(byName);
  if (opt.dirsFirst) entries.sort((x, y) => Number(y.isDir) - Number(x.isDir));
  return entries;
}

/** The entries of a directory, or null when it cannot be read. */
function tryChildren(dir) {
  try {
    return children(dir);
  } catch {
    return null;
  }
}

const opened = (line, entries) => (entries ? line : `${line}  [error opening dir]`);

const counts = { dirs: 0, files: 0 };

function label(entry) {
  const shown = opt.fullPath ? entry.path : entry.name;
  if (entry.link !== null) return `${paint("1;36", shown)} -> ${entry.link}`;
  return entry.isDir ? paint("1;34", shown) : shown;
}

/** Print `entries`, the contents of a directory at `depth` (the root is 0). */
function walk(entries, prefix, depth) {
  entries.forEach((entry, index) => {
    const last = index === entries.length - 1;
    const line = `${prefix}${last ? "└── " : "├── "}${sizeField(entry.stat?.size ?? 0)}${label(entry)}`;
    if (!entry.isDir) {
      counts.files++;
      emit(line);
      return;
    }
    counts.dirs++;
    // Symbolic links to directories are not followed, as in tree without -l.
    if (entry.link !== null || depth + 1 >= opt.level) {
      emit(line);
      return;
    }
    if (notDescended.has(entry.name)) {
      emit(`${line}/ …`);
      return;
    }
    const inner = tryChildren(entry.path);
    emit(opened(line, inner));
    if (inner) walk(inner, `${prefix}${last ? "    " : "│   "}`, depth + 1);
  });
}

let status = 0;
for (const root of roots) {
  let stat;
  try {
    stat = statSync(root);
  } catch {
    stat = null;
  }
  if (stat && !stat.isDirectory()) {
    // A file named on the command line is listed as itself.
    emit(`${sizeField(stat.size)}${root}`);
    counts.files++;
    continue;
  }
  const entries = stat ? tryChildren(root) : null;
  if (!entries) {
    emit(`${root}  [error opening dir]`);
    status = 2;
    continue;
  }
  emit(`${sizeField(stat.size)}${paint("1;34", root)}`);
  walk(entries, "", 0);
}

if (opt.report) {
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const dirs = plural(counts.dirs, "directory", "directories");
  emit("");
  emit(opt.dirsOnly ? dirs : `${dirs}, ${plural(counts.files, "file", "files")}`);
}
flush();
exit(status);
