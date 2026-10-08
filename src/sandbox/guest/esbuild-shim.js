// Sparkbox replacement for the esbuild package inside the sandbox. The
// sandbox runtime cannot execute esbuild, so every call is forwarded to the
// Sparkbox page over this process's stdio: requests go out as marked stdout
// lines, replies come back on stdin. Plugin callbacks run here and are
// invoked by the page through the same channel, mirroring esbuild's own
// binary protocol.
import readline from "node:readline";

export const version = "0.28.2";
const MARK = "@@sparkbox-rpc@@";
const pending = new Map();
const contexts = new Map();
const pluginData = new Map();
let nextId = 1;
let nextContext = 1;
let nextPluginData = 1;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.op === "result") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(toError(message.error));
    } else if (message.op === "callback") {
      void runCallback(message);
    }
  });
}

function send(message) {
  process.stdout.write(`${MARK + JSON.stringify(message)}\n`);
}

function request(message) {
  listen();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ ...message, id });
  });
}

function toError(error) {
  const result = new Error(error?.message ? error.message : "esbuild failed");
  if (error && Array.isArray(error.errors)) result.errors = error.errors;
  if (error && Array.isArray(error.warnings)) result.warnings = error.warnings;
  return result;
}

function serializeError(error) {
  return {
    message: error?.message ? error.message : String(error),
    stack: error?.stack ? String(error.stack) : undefined,
  };
}

/** Plugin data never crosses the channel; it is swapped for a token. */
function packPluginData(value) {
  if (value === undefined) return undefined;
  const token = nextPluginData++;
  pluginData.set(token, value);
  return { __sparkboxPluginData: token };
}
function unpackPluginData(value) {
  if (value && typeof value === "object" && "__sparkboxPluginData" in value)
    return pluginData.get(value.__sparkboxPluginData);
  return value;
}

function packResult(result) {
  if (!result || typeof result !== "object") return result;
  const out = { ...result };
  if ("pluginData" in out) out.pluginData = packPluginData(out.pluginData);
  if (out.contents instanceof Uint8Array) {
    out.contentsBase64 = Buffer.from(out.contents).toString("base64");
    delete out.contents;
  }
  return out;
}

async function runCallback(message) {
  const context = contexts.get(message.ctx);
  const reply = (ok, value) => send({ op: "callback-result", id: message.id, ok, value });
  if (!context) return reply(false, { message: "unknown esbuild context" });
  try {
    const plugin = context.plugins[message.plugin];
    const callback = plugin[message.hook][message.index];
    const args = message.args ? { ...message.args } : {};
    if ("pluginData" in args) args.pluginData = unpackPluginData(args.pluginData);
    const result = await callback(args);
    reply(true, packResult(result));
  } catch (error) {
    reply(false, serializeError(error));
  }
}

function serializeFilter(filter) {
  if (!(filter instanceof RegExp))
    throw new Error("esbuild plugin filters must be regular expressions");
  return { source: filter.source, flags: filter.flags };
}

/** Run each plugin's setup locally, recording hooks for the page to call. */
async function registerPlugins(ctx, plugins, options) {
  const registered = [];
  for (const plugin of plugins) {
    const record = {
      name: plugin.name,
      onStart: [],
      onEnd: [],
      onResolve: [],
      onLoad: [],
      onDispose: [],
    };
    const descriptors = { onResolve: [], onLoad: [] };
    const build = {
      initialOptions: options,
      esbuild: api,
      onStart(callback) {
        record.onStart.push(callback);
      },
      onEnd(callback) {
        record.onEnd.push(callback);
      },
      onDispose(callback) {
        record.onDispose.push(callback);
      },
      onResolve(selector, callback) {
        descriptors.onResolve.push({
          filter: serializeFilter(selector.filter),
          namespace: selector.namespace,
        });
        record.onResolve.push(callback);
      },
      onLoad(selector, callback) {
        descriptors.onLoad.push({
          filter: serializeFilter(selector.filter),
          namespace: selector.namespace,
        });
        record.onLoad.push(callback);
      },
      resolve(path, resolveOptions) {
        const packed = resolveOptions ? { ...resolveOptions } : {};
        if ("pluginData" in packed) packed.pluginData = packPluginData(packed.pluginData);
        return request({ op: "resolve", ctx, path, options: packed });
      },
    };
    await plugin.setup(build);
    registered.push({
      record,
      descriptor: {
        name: plugin.name,
        onStart: record.onStart.length,
        onEnd: record.onEnd.length,
        onResolve: descriptors.onResolve,
        onLoad: descriptors.onLoad,
      },
    });
  }
  return registered;
}

export async function context(options) {
  const { plugins = [], ...rest } = options || {};
  const ctx = nextContext++;
  const registered = await registerPlugins(ctx, plugins, options);
  contexts.set(ctx, { plugins: registered.map((entry) => entry.record) });
  await request({
    op: "context",
    ctx,
    options: rest,
    plugins: registered.map((entry) => entry.descriptor),
  });
  const unpack = (result) => {
    if (result && Array.isArray(result.outputFiles))
      result.outputFiles = result.outputFiles.map((file) => ({
        path: file.path,
        text: file.text,
        hash: file.hash || "",
        get contents() {
          return new TextEncoder().encode(file.text);
        },
      }));
    return result;
  };
  return {
    rebuild: async () => unpack(await request({ op: "rebuild", ctx })),
    watch: async () => {
      throw new Error("esbuild watch mode is not available in Sparkbox");
    },
    serve: async () => {
      throw new Error("esbuild serve is not available in Sparkbox");
    },
    cancel: () => request({ op: "cancel", ctx }),
    dispose: async () => {
      const entry = contexts.get(ctx);
      await request({ op: "dispose", ctx }).catch(() => {});
      contexts.delete(ctx);
      for (const plugin of entry ? entry.plugins : [])
        for (const callback of plugin.onDispose) callback();
    },
  };
}

export async function build(options) {
  const instance = await context(options);
  try {
    return await instance.rebuild();
  } finally {
    await instance.dispose();
  }
}

export function transform(input, options) {
  const code = typeof input === "string" ? input : Buffer.from(input).toString();
  return request({ op: "transform", code, options: options || {} });
}

export function formatMessages(messages, options) {
  return request({ op: "formatMessages", messages, options: options || {} });
}

export function analyzeMetafile(metafile, options) {
  return request({ op: "analyzeMetafile", metafile, options: options || {} });
}

export function buildSync() {
  throw new Error("esbuild's synchronous API is not available in Sparkbox");
}
export const transformSync = buildSync;
export const formatMessagesSync = buildSync;
export const analyzeMetafileSync = buildSync;
export function initialize() {
  return Promise.resolve();
}
export function stop() {
  return Promise.resolve();
}

const api = {
  version,
  context,
  build,
  transform,
  formatMessages,
  analyzeMetafile,
  buildSync,
  transformSync,
  formatMessagesSync,
  analyzeMetafileSync,
  initialize,
  stop,
};
export default api;
