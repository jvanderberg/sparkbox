// curl for the Sparkbox sandbox: a subset of curl's options, output and exit codes, built
// on the runtime's fetch. The sandbox reaches the internet only through Sparkbox's relay.
//
// Deliberate simplifications: there is no progress meter at all; multipart forms (-F),
// cookies, URL globbing and protocols other than HTTP(S) are not supported; fetch does not
// expose the HTTP version, so status lines always read HTTP/1.1; fetch adds headers of its
// own (Host, Accept-Encoding, ...) and decompresses bodies itself, so -v shows only the
// headers set here and -k / --compressed change nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { err, exit, fail, isExit, out, program, readStdin } from "./io.mjs";

const USAGE = `Usage: curl [options...] <url>...
 -d, --data <data>         POST data (@file or @- reads a file or stdin; several join with &);
                           also --data-raw, --data-binary, --data-urlencode
     --json <data>         POST JSON (sets Content-Type and Accept)
 -f, --fail                Exit 22 on HTTP errors without output (--fail-with-body keeps it)
 -G, --get                 Put the -d data in the URL query instead
 -H, --header <header>     Add a header; "Name:" removes one
 -i, --include             Include the response headers in the output
 -I, --head                Fetch the headers only
 -L, --location            Follow redirects (--max-redirs <n>, default 50)
 -m, --max-time <seconds>  Give up after this long (exit 28)
 -o, --output <file>       Write to a file (--output-dir <dir>, --create-dirs)
 -O, --remote-name         Write to a file named like the URL's last path segment
 -s, --silent              No error messages (-S, --show-error shows them again)
 -u, --user <user:pass>    Basic authentication
 -A, --user-agent <name>   User-Agent header
 -e, --referer <url>       Referer header
 -D, --dump-header <file>  Write the response headers to a file (- for stdout)
 -v, --verbose             Show the request and response headers on stderr
 -w, --write-out <format>  After each transfer print %{http_code}, %{url_effective},
                           %{content_type}, %{size_download}, %{time_total}, ...
 -X, --request <method>    Request method
This curl runs on fetch through Sparkbox's relay. Not supported: -F/--form, cookies, URL
globbing, FTP and other protocols. -k, --compressed and -# are accepted and ignored.
`;

// Long name -> [short letter or null, takes a value].
const OPTIONS = {
  output: ["o", true],
  "remote-name": ["O", false],
  "output-dir": [null, true],
  "create-dirs": [null, false],
  silent: ["s", false],
  "show-error": ["S", false],
  fail: ["f", false],
  "fail-with-body": [null, false],
  location: ["L", false],
  "max-redirs": [null, true],
  head: ["I", false],
  include: ["i", false],
  request: ["X", true],
  header: ["H", true],
  "user-agent": ["A", true],
  referer: ["e", true],
  user: ["u", true],
  data: ["d", true],
  "data-ascii": [null, true],
  "data-raw": [null, true],
  "data-binary": [null, true],
  "data-urlencode": [null, true],
  json: [null, true],
  get: ["G", false],
  "write-out": ["w", true],
  "dump-header": ["D", true],
  verbose: ["v", false],
  insecure: ["k", false],
  compressed: [null, false],
  "max-time": ["m", true],
  "connect-timeout": [null, true],
  "progress-bar": ["#", false],
  "no-progress-meter": [null, false],
  globoff: ["g", false],
  url: [null, true],
  help: ["h", false],
  form: ["F", true],
};
const SHORT = Object.fromEntries(
  Object.entries(OPTIONS)
    .filter(([, [letter]]) => letter)
    .map(([name, [letter]]) => [letter, name]),
);

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const REASONS = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};
// fetch refuses or manages these itself; curl users set them out of habit.
const UNSETTABLE = new Set([
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
]);
const RELAY_HINT =
  " (the sandbox reaches the internet only through Sparkbox's relay; it may be off)";

const opts = {
  urls: [],
  outputs: [],
  headers: [],
  data: [],
  maxRedirs: 50,
};

function usageError(message) {
  fail(`${message}\ncurl: try 'curl --help' for more information`, 2);
}

function number(name, value) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed))
    usageError(`option ${name}: expected a proper numerical parameter`);
  return parsed;
}

function readSource(name) {
  try {
    return name === "-" ? readStdin() : readFileSync(name);
  } catch {
    err(`Warning: Couldn't read data from file "${name}", this makes an empty POST.\n`);
    return Buffer.alloc(0);
  }
}

// curl_easy_escape: everything but the unreserved characters is percent-encoded.
function escapeBytes(bytes) {
  let text = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    text += /[A-Za-z0-9._~-]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return text;
}

// --data-urlencode: "content", "=content", "name=content", "@file" or "name@file".
function urlencodeData(value) {
  const match = /^([^=@]*)([=@])([\s\S]*)$/.exec(value);
  if (!match) return escapeBytes(Buffer.from(value));
  const [, name, kind, rest] = match;
  const encoded = escapeBytes(kind === "@" ? readSource(rest) : Buffer.from(rest));
  return name ? `${name}=${encoded}` : encoded;
}

function addData(kind, value) {
  let bytes;
  if (kind === "data-urlencode") bytes = Buffer.from(urlencodeData(value));
  else if (kind === "data-raw" || !value.startsWith("@")) bytes = Buffer.from(value);
  else {
    bytes = readSource(value.slice(1));
    // -d (unlike --data-binary) drops carriage returns and newlines from files.
    if (kind === "data" || kind === "data-ascii")
      bytes = Buffer.from(bytes.filter((byte) => byte !== 10 && byte !== 13));
  }
  opts.data.push({ bytes, json: kind === "json" });
  if (kind === "json") opts.json = true;
}

function apply(name, value) {
  switch (name) {
    case "help":
      out(USAGE);
      exit(0);
      break;
    case "form":
      usageError("option -F/--form is not supported here (no multipart forms); use -d or --json");
      break;
    case "url":
      opts.urls.push(value);
      break;
    case "output":
      opts.outputs.push({ file: value });
      break;
    case "remote-name":
      opts.outputs.push({ remote: true });
      break;
    case "output-dir":
      opts.outputDir = value;
      break;
    case "create-dirs":
      opts.createDirs = true;
      break;
    case "silent":
      opts.silent = true;
      break;
    case "show-error":
      opts.showError = true;
      break;
    case "fail":
      opts.fail = true;
      break;
    case "fail-with-body":
      opts.fail = true;
      opts.failWithBody = true;
      break;
    case "location":
      opts.location = true;
      break;
    case "max-redirs":
      opts.maxRedirs = number("--max-redirs", value);
      break;
    case "head":
      opts.head = true;
      break;
    case "include":
      opts.include = true;
      break;
    case "request":
      opts.method = value;
      break;
    case "header":
      opts.headers.push(value);
      break;
    case "user-agent":
      opts.userAgent = value;
      break;
    case "referer":
      opts.referer = value;
      break;
    case "user":
      opts.user = value;
      break;
    case "data":
    case "data-ascii":
    case "data-raw":
    case "data-binary":
    case "data-urlencode":
    case "json":
      addData(name, value);
      break;
    case "get":
      opts.get = true;
      break;
    case "write-out":
      opts.writeOut = value.startsWith("@") ? readSource(value.slice(1)).toString() : value;
      break;
    case "dump-header":
      opts.dumpHeader = value;
      break;
    case "verbose":
      opts.verbose = true;
      break;
    case "max-time":
      opts.maxTime = number("-m", value);
      break;
    case "connect-timeout":
      number("--connect-timeout", value);
      break;
    // Accepted and ignored: insecure, compressed, progress-bar, no-progress-meter, globoff.
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
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq > 0 ? eq : undefined);
      const spec = OPTIONS[name];
      if (!spec) usageError(`option --${name}: is unknown`);
      if (!spec[1]) {
        if (eq > 0) usageError(`option --${name}: does not take a value`);
        apply(name);
        continue;
      }
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) usageError(`option --${name}: requires parameter`);
      apply(name, value);
    } else {
      // A cluster of short options (-fsSL); one that takes a value ends it (-oFILE, -o FILE).
      for (let j = 1; j < arg.length; j++) {
        const name = SHORT[arg[j]];
        if (!name) usageError(`option -${arg[j]}: is unknown`);
        if (!OPTIONS[name][1]) {
          apply(name);
          continue;
        }
        const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i];
        if (value === undefined) usageError(`option -${arg[j]}: requires parameter`);
        apply(name, value);
        break;
      }
    }
  }
}

function parseUrl(raw, base) {
  let text = raw;
  if (!base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) text = `http://${raw}`;
  let url;
  try {
    url = new URL(text, base);
  } catch {
    return { code: 3, message: "URL rejected: Malformed input to a URL function" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { code: 1, message: `Protocol "${url.protocol.slice(0, -1)}" not supported` };
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
function networkFailure(error, url, elapsed) {
  const cause = error?.cause ?? {};
  const code = String(cause.code ?? error?.code ?? "");
  const detail = String(cause.message || error?.message || error);
  const host = url.hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const hint = isLocal(host) ? "" : RELAY_HINT;
  if (
    /^EAI_|^ENOTFOUND$/.test(code) ||
    /getaddrinfo|could not resolve|name not known/i.test(detail)
  )
    return [6, `Could not resolve host: ${host}${hint}`];
  if (/CERT|SSL|TLS/.test(code)) return [35, `TLS connect error: ${detail}`];
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET")
    return [56, `Recv failure: ${detail}${hint}`];
  const reason = code === "ECONNREFUSED" ? "Couldn't connect to server" : detail;
  return [7, `Failed to connect to ${host} port ${port} after ${elapsed} ms: ${reason}${hint}`];
}

function requestHeaders(url, hasBody) {
  const list = [
    ["User-Agent", "curl/8.11.1"],
    ["Accept", "*/*"],
  ];
  const remove = (name) => {
    const lower = name.toLowerCase();
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i][0].toLowerCase() === lower) list.splice(i, 1);
  };
  const set = (name, value) => {
    remove(name);
    if (value !== "") list.push([name, value]);
  };
  if (opts.userAgent !== undefined) set("User-Agent", opts.userAgent);
  if (opts.referer) set("Referer", opts.referer);
  const user =
    opts.user ??
    (url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : "");
  if (user) set("Authorization", `Basic ${Buffer.from(user).toString("base64")}`);
  if (opts.json) {
    set("Content-Type", "application/json");
    set("Accept", "application/json");
  } else if (hasBody) set("Content-Type", "application/x-www-form-urlencoded");
  const seen = new Set();
  for (const header of opts.headers) {
    // "Name: value" adds, "Name:" removes, "Name;" sends the header empty.
    const colon = header.indexOf(":");
    const empty = colon < 0 && /^[^;]+;\s*$/.test(header);
    if (colon <= 0 && !empty) continue;
    const name = (empty ? header.slice(0, header.indexOf(";")) : header.slice(0, colon)).trim();
    const value = empty ? "" : header.slice(colon + 1).trim();
    const lower = name.toLowerCase();
    if (UNSETTABLE.has(lower)) continue;
    if (value === "" && !empty) {
      remove(name);
      continue;
    }
    if (!seen.has(lower)) remove(name);
    seen.add(lower);
    list.push([name, value]);
  }
  return list;
}

function toHeaders(list) {
  const headers = new Headers();
  for (const [name, value] of list) headers.append(name, value);
  return headers;
}

function statusLine(response) {
  const reason = response.statusText || REASONS[response.status] || "";
  return `HTTP/1.1 ${response.status}${reason ? ` ${reason}` : ""}`;
}

function headerBlock(response) {
  let block = `${statusLine(response)}\r\n`;
  for (const [name, value] of response.headers) block += `${name}: ${value}\r\n`;
  return `${block}\r\n`;
}

function writeOut(template, info) {
  return template.replace(
    /%%|%header\{([^}]*)\}|%\{([^}]*)\}|\\([nrt\\])/g,
    (match, header, name, escaped) => {
      if (match === "%%") return "%";
      if (header !== undefined) return info.headers?.get(header) ?? "";
      if (escaped !== undefined) return { n: "\n", r: "\r", t: "\t", "\\": "\\" }[escaped];
      switch (name) {
        case "http_code":
        case "response_code":
          return String(info.status).padStart(3, "0");
        case "url_effective":
          return info.url;
        case "url":
          return info.requested;
        case "content_type":
          return info.headers?.get("content-type") ?? "";
        case "size_download":
          return String(info.size);
        case "size_upload":
          return String(info.uploaded);
        case "time_total":
          return ((Date.now() - info.started) / 1000).toFixed(6);
        case "num_redirects":
          return String(info.redirects);
        case "redirect_url":
          return info.redirectUrl;
        case "method":
          return info.method;
        case "scheme":
          return info.scheme;
        case "exitcode":
          return String(info.exit);
        case "errormsg":
          return info.error;
        default:
          err(`curl: unknown --write-out variable: '${name}'\n`);
          return "";
      }
    },
  );
}

function outputPath(output, url) {
  if (!output) return { path: null };
  let name = output.file;
  if (output.remote) {
    name = url.pathname.split("/").pop();
    if (!name) return { code: 23, message: "Remote file name has no length!" };
  }
  if (name === "-") return { path: null };
  if (opts.outputDir && !isAbsolute(name)) name = join(opts.outputDir, name);
  return { path: name };
}

function write(path, data) {
  if (path === null) out(data);
  else if (path !== "/dev/null") {
    if (opts.createDirs) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
}

function joinData() {
  const parts = [];
  for (const piece of opts.data) {
    // Several -d join with &; several --json concatenate.
    if (parts.length > 0 && !piece.json) parts.push(Buffer.from("&"));
    parts.push(piece.bytes);
  }
  return Buffer.concat(parts);
}

let manualRedirects = true;

async function transfer(raw, output) {
  const info = {
    started: Date.now(),
    requested: raw,
    url: raw,
    status: 0,
    size: 0,
    uploaded: 0,
    redirects: 0,
    redirectUrl: "",
    method: "",
    scheme: "",
    headers: null,
    exit: 0,
    error: "",
  };
  const finish = (code, message) => {
    info.exit = code;
    if (message) {
      info.error = message;
      if (!opts.silent || opts.showError) err(`curl: (${code}) ${message}\n`);
    }
    if (opts.writeOut !== undefined) out(writeOut(opts.writeOut, info));
    return code;
  };

  const parsed = parseUrl(raw);
  if (!parsed.url) return finish(parsed.code, parsed.message);
  let url = parsed.url;
  let body = opts.data.length > 0 ? joinData() : undefined;
  if (opts.get && body) {
    const query = body.toString();
    url = new URL(`${url.href}${url.search ? "&" : "?"}${query}`);
    body = undefined;
  }
  const target = outputPath(output, url);
  if (target.code) return finish(target.code, target.message);

  let headers = requestHeaders(url, body !== undefined);
  // fetch refuses URLs with credentials; requestHeaders turned them into Basic auth.
  url.username = "";
  url.password = "";
  let method = opts.method ?? (opts.head ? "HEAD" : body !== undefined ? "POST" : "GET");
  info.uploaded = body?.length ?? 0;

  const controller = new AbortController();
  let timedOut = false;
  const timer =
    opts.maxTime > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.maxTime * 1000)
      : undefined;
  const blocks = [];
  try {
    let response;
    for (;;) {
      info.url = url.href;
      info.method = method;
      info.scheme = url.protocol.slice(0, -1).toUpperCase();
      if ((method === "GET" || method === "HEAD") && body !== undefined)
        return finish(
          2,
          `fetch cannot send a body with ${method}; use -G to send the data in the query`,
        );
      if (opts.verbose) {
        let lines = `> ${method} ${url.pathname}${url.search} HTTP/1.1\n> Host: ${url.host}\n`;
        for (const [name, value] of headers) lines += `> ${name}: ${value}\n`;
        err(`${lines}>\n`);
      }
      let sent;
      try {
        sent = toHeaders(headers);
      } catch (error) {
        if (isExit(error)) throw error;
        return finish(2, `invalid header: ${error?.message ?? error}`);
      }
      response = await fetch(url, {
        method,
        headers: sent,
        body,
        redirect: manualRedirects ? "manual" : "follow",
        signal: controller.signal,
      });
      // Browsers (and maybe this runtime) hide redirect responses from "manual" fetches:
      // they come back opaque, with status 0. Then fetch must follow redirects itself, which
      // also means its own limit (20) instead of --max-redirs.
      if (manualRedirects && (response.type === "opaqueredirect" || response.status === 0)) {
        manualRedirects = false;
        if (!opts.location) {
          if (!opts.silent)
            err(
              "curl: note: the response is a redirect this runtime cannot show; add -L to follow it\n",
            );
          return finish(0);
        }
        continue;
      }
      info.status = response.status;
      info.headers = response.headers;
      if (response.redirected) info.url = response.url;
      blocks.push(headerBlock(response));
      if (opts.verbose) {
        let lines = `< ${statusLine(response)}\n`;
        for (const [name, value] of response.headers) lines += `< ${name}: ${value}\n`;
        err(`${lines}<\n`);
      }
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || !location) break;
      const next = parseUrl(location, url);
      if (!opts.location) {
        info.redirectUrl = next.url?.href ?? "";
        break;
      }
      if (opts.maxRedirs >= 0 && info.redirects >= opts.maxRedirs)
        return finish(47, `Maximum (${opts.maxRedirs}) redirects followed`);
      if (!next.url) return finish(next.code, next.message);
      await response.arrayBuffer().catch(() => {});
      // Like curl: 303 turns into GET, and so do 301/302 after a POST unless -X set the method.
      const status = response.status;
      if (
        (status === 303 && method !== "HEAD") ||
        ((status === 301 || status === 302) && method === "POST" && !opts.method)
      ) {
        method = "GET";
        body = undefined;
        headers = headers.filter(([name]) => name.toLowerCase() !== "content-type");
      }
      // Credentials are not sent on to another host.
      if (next.url.origin !== url.origin)
        headers = headers.filter(
          ([name]) => !["authorization", "cookie"].includes(name.toLowerCase()),
        );
      if (opts.verbose) err(`* Issue another request to this URL: '${next.url.href}'\n`);
      url = next.url;
      info.redirects++;
    }

    const bytes = method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    info.size = bytes.length;
    const failed = opts.fail && response.status >= 400;
    const headerText = Buffer.from(blocks.join(""));
    try {
      if (opts.dumpHeader !== undefined)
        write(opts.dumpHeader === "-" ? null : opts.dumpHeader, headerText);
      if (!failed || opts.failWithBody) {
        const parts = [];
        if (opts.include || opts.head) parts.push(headerText);
        if (!opts.head) parts.push(bytes);
        write(target.path, Buffer.concat(parts));
      }
    } catch (error) {
      if (isExit(error)) throw error;
      return finish(23, `Failure writing output to destination: ${error?.message ?? error}`);
    }
    if (failed) return finish(22, `The requested URL returned error: ${response.status}`);
    return finish(0);
  } catch (error) {
    if (isExit(error)) throw error;
    const elapsed = Date.now() - info.started;
    if (timedOut)
      return finish(28, `Operation timed out after ${elapsed} milliseconds with 0 bytes received`);
    const [code, message] = networkFailure(error, url, elapsed);
    return finish(code, message);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  parseArgs(process.argv.slice(2));
  if (opts.urls.length === 0) usageError("no URL specified!");
  let code = 0;
  for (let i = 0; i < opts.urls.length; i++) {
    const result = await transfer(opts.urls[i], opts.outputs[i]);
    if (result !== 0) code = result;
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
    err(`${program}: (2) ${error?.stack ?? error}\n`);
    process.exit(2);
  },
);
