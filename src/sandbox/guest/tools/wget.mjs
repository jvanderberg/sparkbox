// wget for the Sparkbox sandbox: downloads URLs into files with a subset of wget's options
// and exit codes, built on the runtime's fetch. The sandbox reaches the internet only
// through Sparkbox's relay. There is no progress bar, recursion, retrying or resuming.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, exit, fail, isExit, out, program } from "./io.mjs";

const USAGE = `Usage: wget [OPTION]... [URL]...
  -O, --output-document=FILE  write to FILE (- for stdout); several URLs append
  -P, --directory-prefix=DIR  save files under DIR
  -q, --quiet                 no output at all
  -nv, --no-verbose           one line per download
      --header=STRING         add a header ("Name: value")
  -U, --user-agent=AGENT      User-Agent header
      --post-data=STRING      send STRING with POST
  -T, --timeout=SECONDS       give up after this long
      --max-redirect=NUM      follow at most NUM redirects (default 20)
This wget runs on fetch through Sparkbox's relay. -c, -t and --no-check-certificate are
accepted and ignored; recursion (-r) and other protocols are not supported.
`;

// Long name -> [short letter or null, takes a value].
const OPTIONS = {
  "output-document": ["O", true],
  "directory-prefix": ["P", true],
  quiet: ["q", false],
  "no-verbose": [null, false],
  verbose: ["v", false],
  header: [null, true],
  "user-agent": ["U", true],
  "post-data": [null, true],
  timeout: ["T", true],
  "max-redirect": [null, true],
  continue: ["c", false],
  tries: ["t", true],
  "no-check-certificate": [null, false],
  help: ["h", false],
};
const SHORT = Object.fromEntries(
  Object.entries(OPTIONS)
    .filter(([, [letter]]) => letter)
    .map(([name, [letter]]) => [letter, name]),
);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const REASONS = {
  200: "OK",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  500: "Internal Server Error",
  503: "Service Unavailable",
};
const RELAY_HINT =
  " (the sandbox reaches the internet only through Sparkbox's relay; it may be off)";

const opts = { urls: [], headers: [], maxRedirect: 20 };

function usageError(message) {
  fail(`${message}\nUsage: wget [OPTION]... [URL]...\n\nTry 'wget --help' for more options.`, 2);
}

function number(name, value) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed))
    usageError(`${name}: Invalid number '${value}'.`);
  return parsed;
}

function apply(name, value) {
  switch (name) {
    case "help":
      out(USAGE);
      exit(0);
      break;
    case "output-document":
      opts.output = value;
      break;
    case "directory-prefix":
      opts.prefix = value;
      break;
    case "quiet":
      opts.quiet = true;
      break;
    case "no-verbose":
      opts.brief = true;
      break;
    case "verbose":
      opts.brief = false;
      break;
    case "header":
      opts.headers.push(value);
      break;
    case "user-agent":
      opts.userAgent = value;
      break;
    case "post-data":
      opts.postData = value;
      break;
    case "timeout":
      opts.timeout = number("--timeout", value);
      break;
    case "max-redirect":
      opts.maxRedirect = number("--max-redirect", value);
      break;
    // Accepted and ignored: continue, tries, no-check-certificate.
  }
}

function parseArgs(argv) {
  let endOfOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (endOfOptions || arg === "-" || !arg.startsWith("-")) {
      opts.urls.push(arg);
    } else if (arg === "--") {
      endOfOptions = true;
    } else if (arg === "-nv") {
      opts.brief = true;
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq > 0 ? eq : undefined);
      const spec = OPTIONS[name];
      if (!spec) usageError(`unrecognized option '--${name}'`);
      if (!spec[1]) {
        if (eq > 0) usageError(`option '--${name}' doesn't allow an argument`);
        apply(name);
        continue;
      }
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) usageError(`option '--${name}' requires an argument`);
      apply(name, value);
    } else {
      // A cluster of short options (-qO-); one that takes a value ends it.
      for (let j = 1; j < arg.length; j++) {
        const name = SHORT[arg[j]];
        if (!name) usageError(`invalid option -- '${arg[j]}'`);
        if (!OPTIONS[name][1]) {
          apply(name);
          continue;
        }
        const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i];
        if (value === undefined) usageError(`option requires an argument -- '${arg[j]}'`);
        apply(name, value);
        break;
      }
    }
  }
}

const say = (text) => {
  if (!opts.quiet && !opts.brief) err(text);
};
const timestamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function parseUrl(raw, base) {
  let text = raw;
  if (!base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) text = `http://${raw}`;
  let url;
  try {
    url = new URL(text, base);
  } catch {
    return { message: `${raw}: Invalid URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { message: `${raw}: Unsupported scheme '${url.protocol.slice(0, -1)}'.` };
  return { url };
}

function isLocal(host) {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "[::1]" ||
    host === "0.0.0.0"
  );
}

// fetch errors are generic ("fetch failed"); the cause, when there is one, carries a code.
function networkFailure(error, url) {
  const cause = error?.cause ?? {};
  const code = String(cause.code ?? error?.code ?? "");
  const detail = String(cause.message || error?.message || error);
  const hint = isLocal(url.hostname) ? "" : RELAY_HINT;
  if (
    /^EAI_|^ENOTFOUND$/.test(code) ||
    /getaddrinfo|could not resolve|name not known/i.test(detail)
  )
    return `wget: unable to resolve host address '${url.hostname}'${hint}`;
  const reason = code === "ECONNREFUSED" ? "Connection refused." : detail;
  return `Connecting to ${url.host}... failed: ${reason}${hint}`;
}

// The file name wget would pick: the URL's last path segment, index.html for a directory,
// with .1, .2, ... appended when the name is taken.
function localName(url) {
  const segment = url.pathname.split("/").pop() ?? "";
  let name;
  try {
    name = decodeURIComponent(segment);
  } catch {
    name = segment;
  }
  name = name.replaceAll("/", "%2F") || "index.html";
  const path = opts.prefix ? join(opts.prefix, name) : name;
  if (!existsSync(path)) return path;
  for (let n = 1; ; n++) if (!existsSync(`${path}.${n}`)) return `${path}.${n}`;
}

let wroteDocument = false;

async function download(raw) {
  const parsed = parseUrl(raw);
  if (!parsed.url) {
    if (!opts.quiet) err(`${parsed.message}\n`);
    return 1;
  }
  let url = parsed.url;
  const headers = new Headers({ "User-Agent": "Wget/1.21.4", Accept: "*/*" });
  if (opts.userAgent !== undefined) headers.set("User-Agent", opts.userAgent);
  let method = "GET";
  let body;
  if (opts.postData !== undefined) {
    method = "POST";
    body = opts.postData;
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }
  for (const header of opts.headers) {
    const colon = header.indexOf(":");
    if (colon <= 0) continue;
    try {
      headers.set(header.slice(0, colon).trim(), header.slice(colon + 1).trim());
    } catch {
      if (!opts.quiet) err(`wget: invalid header '${header}'\n`);
      return 2;
    }
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer =
    opts.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.timeout * 1000)
      : undefined;
  let response;
  let manual = true;
  let redirects = 0;
  try {
    for (;;) {
      say(`--${timestamp()}--  ${url.href}\n`);
      response = await fetch(url, {
        method,
        headers,
        body,
        redirect: manual ? "manual" : "follow",
        signal: controller.signal,
      });
      // Browsers (and maybe this runtime) hide redirect responses from "manual" fetches:
      // they come back opaque, with status 0. Then fetch follows redirects itself.
      if (manual && (response.type === "opaqueredirect" || response.status === 0)) {
        manual = false;
        continue;
      }
      const reason = response.statusText || REASONS[response.status] || "";
      say(`HTTP request sent, awaiting response... ${response.status} ${reason}\n`);
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || !location) break;
      const next = parseUrl(location, url);
      say(`Location: ${location} [following]\n`);
      if (!next.url) {
        if (!opts.quiet) err(`${next.message}\n`);
        return 1;
      }
      if (redirects >= opts.maxRedirect) {
        if (!opts.quiet) err(`${opts.maxRedirect} redirections exceeded.\n`);
        return 8;
      }
      await response.arrayBuffer().catch(() => {});
      // Like wget: only 307 and 308 repeat a POST; the others turn it into a GET.
      if (response.status !== 307 && response.status !== 308) {
        method = "GET";
        body = undefined;
        headers.delete("Content-Type");
      }
      url = next.url;
      redirects++;
    }

    if (response.status >= 400) {
      const reason = response.statusText || REASONS[response.status] || "";
      if (opts.brief && !opts.quiet) err(`${url.href}:\n`);
      if (!opts.quiet) err(`${timestamp()} ERROR ${response.status}: ${reason}.\n`);
      return 8;
    }
    const length = response.headers.get("content-length");
    const type = response.headers.get("content-type");
    say(`Length: ${length ?? "unspecified"}${type ? ` [${type}]` : ""}\n`);
    const toStdout = opts.output === "-";
    const path = opts.output ?? localName(parsed.url);
    say(`Saving to: '${toStdout ? "STDOUT" : path}'\n\n`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const size = `[${bytes.length}/${bytes.length}]`;
    try {
      if (toStdout) out(bytes);
      else {
        if (!opts.output && opts.prefix) mkdirSync(opts.prefix, { recursive: true });
        // -O with several URLs collects them all in the one file.
        writeFileSync(path, bytes, { flag: opts.output && wroteDocument ? "a" : "w" });
        wroteDocument = true;
      }
    } catch (error) {
      if (isExit(error)) throw error;
      if (!opts.quiet) err(`wget: ${path}: ${error?.message ?? error}\n`);
      return 3;
    }
    const name = toStdout ? "-" : path;
    say(`${timestamp()} - ${toStdout ? "written to stdout" : `'${name}' saved`} ${size}\n\n`);
    if (opts.brief && !opts.quiet) err(`${timestamp()} URL:${url.href} ${size} -> "${name}" [1]\n`);
    return 0;
  } catch (error) {
    if (isExit(error)) throw error;
    if (opts.quiet) return 4;
    err(timedOut ? "Read error (Connection timed out).\n" : `${networkFailure(error, url)}\n`);
    return 4;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  parseArgs(process.argv.slice(2));
  if (opts.urls.length === 0)
    fail("missing URL\nUsage: wget [OPTION]... [URL]...\n\nTry 'wget --help' for more options.");
  // wget's rule: with several failures the lowest exit code (other than 0) wins.
  let code = 0;
  for (const raw of opts.urls) {
    const result = await download(raw);
    if (result !== 0 && (code === 0 || result < code)) code = result;
  }
  return code;
}

// Every rejection is caught here: in this runtime an unhandled one ends the process silently.
// Nothing runs after these, so a plain process.exit is enough (and a throw
// from `exit` here would be an unhandled rejection).
main().then(
  (code) => process.exit(code),
  (error) => {
    if (isExit(error)) return;
    err(`${program}: ${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
