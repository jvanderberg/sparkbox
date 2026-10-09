// du for the Sparkbox sandbox: a subset of GNU du.
//
// The sandbox filesystem has no block allocation information, so sizes are
// apparent sizes (st_size, as GNU's --apparent-size), shown in 1024-byte
// blocks rounded up unless another unit is asked for. Directories count
// their own size plus everything below them. Symbolic links are not
// followed, hard links are counted every time they appear, and entries are
// visited in name order (GNU uses directory order).
//
// Supported: -s, -a, -h, -k, -m, -b, -c, -d N / --max-depth=N,
// --exclude=PATTERN (a glob matched against each name), --apparent-size.
import { lstatSync, readdirSync } from "node:fs";
import { err, exit, out } from "./io.mjs";

const help = `Usage: du [OPTION]... [FILE]...
Summarize the apparent size of each FILE, recursively for directories.

  -a, --all             write counts for all files, not just directories
  -b, --bytes           print sizes in bytes
  -c, --total           produce a grand total
  -d, --max-depth=N     print the total for a directory only if it is N or
                        fewer levels below the command line argument
  -h, --human-readable  print sizes in human readable format (e.g., 1K 234M 2G)
  -k                    like --block-size=1K (the default)
  -m                    like --block-size=1M
  -s, --summarize       display only a total for each argument
      --exclude=PATTERN exclude files whose name matches PATTERN
      --apparent-size   accepted; sizes are always apparent sizes here
`;

function usageError(message) {
  err(`du: ${message}\ndu: Try 'du --help' for more information.\n`);
  exit(1);
}

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

const opt = {
  all: false,
  summarize: false,
  total: false,
  maxDepth: Infinity,
  // Bytes per output unit, or "human".
  unit: 1024,
  exclude: [],
};
const paths = [];

function depthValue(value) {
  if (!/^\d+$/.test(value)) usageError(`invalid maximum depth '${value}'`);
  return Number(value);
}

const args = process.argv.slice(2);
for (let k = 0; k < args.length; k++) {
  const arg = args[k];
  if (arg === "--") {
    paths.push(...args.slice(k + 1));
    break;
  }
  if (arg === "-" || !arg.startsWith("-")) {
    paths.push(arg);
    continue;
  }
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    const value = () => {
      if (eq >= 0) return arg.slice(eq + 1);
      if (k + 1 >= args.length) usageError(`option '--${name}' requires an argument`);
      return args[++k];
    };
    if (name === "all") opt.all = true;
    else if (name === "bytes") opt.unit = 1;
    else if (name === "total") opt.total = true;
    else if (name === "max-depth") opt.maxDepth = depthValue(value());
    else if (name === "human-readable") opt.unit = "human";
    else if (name === "summarize") opt.summarize = true;
    else if (name === "exclude") opt.exclude.push(globRegExp(value()));
    else if (name === "apparent-size") {
      // Always the case here.
    } else if (name === "help") {
      out(help);
      exit(0);
    } else if (name === "version") {
      out("du (Sparkbox) 1.0 - a subset of GNU coreutils du\n");
      exit(0);
    } else usageError(`unrecognized option '${arg}'`);
    continue;
  }
  for (let c = 1; c < arg.length; c++) {
    const letter = arg[c];
    switch (letter) {
      case "a":
        opt.all = true;
        break;
      case "b":
        opt.unit = 1;
        break;
      case "c":
        opt.total = true;
        break;
      case "h":
        opt.unit = "human";
        break;
      case "k":
        opt.unit = 1024;
        break;
      case "m":
        opt.unit = 1024 * 1024;
        break;
      case "s":
        opt.summarize = true;
        break;
      case "d": {
        // The depth is the rest of the word (-d1) or the next word (-d 1).
        const rest = arg.slice(c + 1);
        c = arg.length;
        if (!rest && k + 1 >= args.length) usageError("option requires an argument -- 'd'");
        opt.maxDepth = depthValue(rest || args[++k]);
        break;
      }
      default:
        usageError(`invalid option -- '${letter}'`);
    }
  }
}
if (opt.summarize && opt.maxDepth !== Infinity && opt.maxDepth !== 0)
  usageError(`warning: summarizing conflicts with --max-depth=${opt.maxDepth}`);
if (opt.summarize && opt.all) usageError("cannot both summarize and show all entries");
if (opt.summarize) opt.maxDepth = 0;
if (paths.length === 0) paths.push(".");

// GNU's -h: powers of 1024, rounded up, one decimal below 10.
function human(bytes) {
  if (bytes < 1024) return String(bytes);
  const units = "KMGTPEZY";
  let unit = 0;
  let value = bytes / 1024;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (value < 10) {
    const tenths = Math.ceil(value * 10);
    if (tenths < 100) return `${(tenths / 10).toFixed(1)}${units[unit]}`;
    return `10${units[unit]}`;
  }
  const whole = Math.ceil(value);
  if (whole >= 1024 && unit < units.length - 1) return `1.0${units[unit + 1]}`;
  return `${whole}${units[unit]}`;
}

const format = (bytes) =>
  opt.unit === "human" ? human(bytes) : String(Math.ceil(bytes / opt.unit));

let pending = [];
function emit(bytes, path) {
  pending.push(`${format(bytes)}\t${path}\n`);
  if (pending.length >= 512) flush();
}
function flush() {
  if (pending.length === 0) return;
  out(pending.join(""));
  pending = [];
}

function reason(error) {
  const known = {
    ENOENT: "No such file or directory",
    EACCES: "Permission denied",
    ENOTDIR: "Not a directory",
  };
  return known[error?.code] ?? error?.message ?? String(error);
}

let status = 0;
function complain(message) {
  flush();
  err(`du: ${message}\n`);
  status = 1;
}

const byName = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** The size of `path` in bytes, printing it and whatever is below it in post-order. */
function walk(path, depth) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    complain(`cannot access '${path}': ${reason(error)}`);
    return 0;
  }
  let size = stat.size;
  if (stat.isDirectory()) {
    let names = [];
    try {
      names = readdirSync(path).sort(byName);
    } catch (error) {
      complain(`cannot read directory '${path}': ${reason(error)}`);
    }
    for (const name of names) {
      if (opt.exclude.some((pattern) => pattern.test(name))) continue;
      size += walk(path.endsWith("/") ? `${path}${name}` : `${path}/${name}`, depth + 1);
    }
    if (depth <= opt.maxDepth) emit(size, path);
  } else if (depth === 0 || (opt.all && depth <= opt.maxDepth)) {
    emit(size, path);
  }
  return size;
}

let grand = 0;
for (const path of paths) grand += walk(path, 0);
if (opt.total) emit(grand, "total");
flush();
exit(status);
