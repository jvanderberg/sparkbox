/**
 * Runs esbuild for the sandbox. The sandbox runtime cannot execute esbuild
 * or WebAssembly, so Vite inside it loads a replacement package that
 * forwards every call here over the process's stdio. This service answers
 * with esbuild-wasm running in the page, reads and writes project files
 * through the sandbox filesystem, and calls plugin hooks back in the
 * sandbox the way esbuild's own binary calls back into JavaScript.
 */
import type * as Esbuild from "esbuild-wasm";
import { exports as resolveExports, legacy as resolveLegacy } from "resolve.exports";
import type { WasmerSandbox } from "../sandbox/wasmer.ts";

type Filter = { source: string; flags: string };
type PluginDescriptor = {
  name: string;
  onStart: number;
  onEnd: number;
  onResolve: { filter: Filter; namespace?: string }[];
  onLoad: { filter: Filter; namespace?: string }[];
};
type Request =
  | { op: "transform"; id: number; code: string; options: Esbuild.TransformOptions }
  | {
      op: "formatMessages";
      id: number;
      messages: Esbuild.PartialMessage[];
      options: Esbuild.FormatMessagesOptions;
    }
  | {
      op: "analyzeMetafile";
      id: number;
      metafile: Esbuild.Metafile;
      options: Esbuild.AnalyzeMetafileOptions;
    }
  | {
      op: "context";
      id: number;
      ctx: number;
      options: Esbuild.BuildOptions;
      plugins: PluginDescriptor[];
    }
  | { op: "rebuild"; id: number; ctx: number }
  | { op: "cancel"; id: number; ctx: number }
  | { op: "dispose"; id: number; ctx: number }
  | { op: "resolve"; id: number; ctx: number; path: string; options: Esbuild.ResolveOptions }
  | { op: "callback-result"; id: number; ok: boolean; value: unknown };

type Context = {
  build: Esbuild.BuildContext;
  write: boolean;
  pluginBuild: Esbuild.PluginBuild | null;
};

const extensions = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".css"];
const loaders: Record<string, Esbuild.Loader> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
  ".css": "css",
  ".txt": "text",
};

let esbuildPromise: Promise<typeof Esbuild> | null = null;
/** esbuild-wasm initialises once per page; the wasm file loads on first use. */
function loadEsbuild(): Promise<typeof Esbuild> {
  if (!esbuildPromise) {
    esbuildPromise = (async () => {
      const [esbuild, wasm] = await Promise.all([
        import("esbuild-wasm"),
        import("esbuild-wasm/esbuild.wasm?url"),
      ]);
      await esbuild.initialize({ wasmURL: wasm.default, worker: true });
      return esbuild;
    })();
    esbuildPromise.catch(() => {
      esbuildPromise = null;
    });
  }
  return esbuildPromise;
}

const dirname = (path: string) => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};
const extension = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const index = base.lastIndexOf(".");
  return index > 0 ? base.slice(index) : "";
};
function normalize(path: string) {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}
const join = (base: string, path: string) => normalize(`${base}/${path}`);

export class EsbuildService {
  private contexts = new Map<number, Context>();
  private callbacks = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextCallback = 1;
  private disposed = false;

  constructor(
    private sandbox: WasmerSandbox,
    private send: (line: string) => Promise<void>,
  ) {}

  /** Handle one RPC line from the guest process. */
  handleLine(line: string) {
    let request: Request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.op === "callback-result") {
      const waiter = this.callbacks.get(request.id);
      if (!waiter) return;
      this.callbacks.delete(request.id);
      if (request.ok) waiter.resolve(request.value);
      else {
        const error = request.value as { message?: string; stack?: string } | null;
        waiter.reject(new Error(error?.message ?? "plugin callback failed"));
      }
      return;
    }
    void this.handle(request).then(
      (value) => this.reply(request.id, true, value),
      (error: unknown) => this.reply(request.id, false, serializeError(error)),
    );
  }

  async dispose() {
    this.disposed = true;
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    for (const waiter of this.callbacks.values()) waiter.reject(new Error("preview stopped"));
    this.callbacks.clear();
    await Promise.all(contexts.map((context) => context.build.dispose().catch(() => {})));
  }

  private async reply(id: number, ok: boolean, value: unknown) {
    if (this.disposed) return;
    await this.send(JSON.stringify({ op: "result", id, ok, value })).catch(() => {});
  }

  private async handle(request: Request): Promise<unknown> {
    const esbuild = await loadEsbuild();
    switch (request.op) {
      case "transform": {
        const result = await esbuild.transform(request.code, request.options);
        return {
          code: result.code,
          map: result.map,
          warnings: result.warnings,
          legalComments: result.legalComments,
          mangleCache: result.mangleCache,
        };
      }
      case "formatMessages":
        return esbuild.formatMessages(request.messages, request.options);
      case "analyzeMetafile":
        return esbuild.analyzeMetafile(request.metafile, request.options);
      case "context": {
        const write = request.options.write !== false;
        const context: Context = {
          build: null as unknown as Esbuild.BuildContext,
          write,
          pluginBuild: null,
        };
        const plugins = [
          ...request.plugins.map((descriptor, index) =>
            this.proxyPlugin(request.ctx, index, descriptor),
          ),
          this.filesystemPlugin(context, request.options),
        ];
        context.build = await esbuild.context({ ...request.options, write: false, plugins });
        this.contexts.set(request.ctx, context);
        return null;
      }
      case "rebuild": {
        const context = this.context(request.ctx);
        const result = await context.build.rebuild();
        const outputFiles = result.outputFiles ?? [];
        if (context.write) {
          for (const file of outputFiles)
            await this.sandbox.writeFile(this.relative(file.path), file.contents);
        }
        return {
          errors: result.errors,
          warnings: result.warnings,
          metafile: result.metafile,
          mangleCache: result.mangleCache,
          outputFiles: context.write
            ? undefined
            : outputFiles.map((file) => ({ path: file.path, text: file.text, hash: file.hash })),
        };
      }
      case "cancel":
        await this.context(request.ctx).build.cancel();
        return null;
      case "dispose": {
        const context = this.contexts.get(request.ctx);
        this.contexts.delete(request.ctx);
        await context?.build.dispose();
        return null;
      }
      case "resolve": {
        const context = this.context(request.ctx);
        if (!context.pluginBuild) throw new Error("resolve is only available during a build");
        return context.pluginBuild.resolve(request.path, request.options);
      }
      default:
        throw new Error(`unknown esbuild request ${(request as { op: string }).op}`);
    }
  }

  /**
   * Bundle a TypeScript or JavaScript file into one ES module for the
   * sandbox's Node, which cannot strip types. Packages and Node built-ins
   * stay imports for Node to resolve; `require`, `__dirname` and
   * `__filename` are provided for code written for CommonJS, and
   * `import.meta.url` names the entry file. Returns the code, or esbuild's
   * messages as text.
   */
  async bundleForNode(entry: string): Promise<{ code: string } | { errors: string }> {
    const esbuild = await loadEsbuild();
    const options: Esbuild.BuildOptions = {
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      absWorkingDir: dirname(entry),
      write: false,
      logLevel: "silent",
      jsx: "automatic",
      define: { "import.meta.url": JSON.stringify(`file://${entry}`) },
      banner: {
        js: [
          'import { createRequire as __sparkboxCreateRequire } from "node:module";',
          `globalThis.require ??= __sparkboxCreateRequire(${JSON.stringify(entry)});`,
          `globalThis.__filename ??= ${JSON.stringify(entry)};`,
          `globalThis.__dirname ??= ${JSON.stringify(dirname(entry))};`,
        ].join("\n"),
      },
    };
    const context: Context = {
      build: null as unknown as Esbuild.BuildContext,
      write: false,
      pluginBuild: null,
    };
    try {
      const result = await esbuild.build({
        ...options,
        plugins: [this.filesystemPlugin(context, options)],
      });
      return { code: result.outputFiles?.[0]?.text ?? "" };
    } catch (error) {
      const failure = error as Partial<Esbuild.BuildFailure>;
      if (!failure.errors?.length) throw error;
      const messages = await esbuild.formatMessages(failure.errors, { kind: "error" });
      return { errors: messages.join("") };
    }
  }

  private context(id: number) {
    const context = this.contexts.get(id);
    if (!context) throw new Error("unknown esbuild context");
    return context;
  }

  /** Ask the guest to run one of its plugin hooks. */
  private invoke(
    ctx: number,
    plugin: number,
    hook: string,
    index: number,
    args: unknown,
  ): Promise<unknown> {
    const id = this.nextCallback++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.send(JSON.stringify({ op: "callback", id, ctx, plugin, hook, index, args })).catch(
        reject,
      );
    });
  }

  private proxyPlugin(ctx: number, plugin: number, descriptor: PluginDescriptor): Esbuild.Plugin {
    const invoke = (hook: string, index: number, args: unknown) =>
      this.invoke(ctx, plugin, hook, index, args);
    return {
      name: descriptor.name,
      setup: (build) => {
        for (let index = 0; index < descriptor.onStart; index++)
          build.onStart(() => invoke("onStart", index, {}) as Promise<Esbuild.OnStartResult>);
        for (let index = 0; index < descriptor.onEnd; index++)
          build.onEnd(
            (result) =>
              invoke("onEnd", index, {
                errors: result.errors,
                warnings: result.warnings,
                metafile: result.metafile,
              }) as Promise<void>,
          );
        descriptor.onResolve.forEach((selector, index) => {
          build.onResolve(
            {
              filter: new RegExp(selector.filter.source, selector.filter.flags),
              namespace: selector.namespace,
            },
            (args) => invoke("onResolve", index, args) as Promise<Esbuild.OnResolveResult>,
          );
        });
        descriptor.onLoad.forEach((selector, index) => {
          build.onLoad(
            {
              filter: new RegExp(selector.filter.source, selector.filter.flags),
              namespace: selector.namespace,
            },
            async (args) => {
              const result = (await invoke("onLoad", index, args)) as
                | (Esbuild.OnLoadResult & { contentsBase64?: string })
                | null
                | undefined;
              if (result?.contentsBase64 !== undefined) {
                const { contentsBase64, ...rest } = result;
                return {
                  ...rest,
                  contents: Uint8Array.from(atob(contentsBase64), (c) => c.charCodeAt(0)),
                };
              }
              return result ?? undefined;
            },
          );
        });
      },
    };
  }

  /** esbuild-wasm has no filesystem; this plugin reads the sandbox instead. */
  private filesystemPlugin(context: Context, options: Esbuild.BuildOptions): Esbuild.Plugin {
    const browser = options.platform !== "node";
    const cwd = options.absWorkingDir ?? this.sandbox.root;
    return {
      name: "sparkbox-filesystem",
      setup: (build) => {
        context.pluginBuild = build;
        build.onResolve({ filter: /.*/ }, async (args) => {
          if (args.namespace !== "file" && args.namespace !== "") return undefined;
          const base = args.resolveDir || (args.importer ? dirname(args.importer) : cwd);
          if (args.path.startsWith("/")) return this.resolveFile(args.path);
          // Bundles for Node leave packages and built-ins to Node.
          if (
            options.packages === "external" &&
            args.kind !== "entry-point" &&
            !args.path.startsWith(".")
          )
            return { path: args.path, external: true };
          if (
            args.path.startsWith("./") ||
            args.path.startsWith("../") ||
            args.kind === "entry-point"
          )
            return this.resolveFile(join(base, args.path));
          return this.resolvePackage(args.path, base, browser);
        });
        build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
          const contents = await this.sandbox.readFile(this.relative(args.path));
          const loader = loaders[extension(args.path)] ?? "file";
          return { contents, loader, resolveDir: dirname(args.path) };
        });
      },
    };
  }

  private relative(path: string) {
    const root = `${this.sandbox.root}/`;
    return path.startsWith(root) ? path.slice(root.length) : path.replace(/^\//, "");
  }

  private async kind(path: string) {
    return (await this.sandbox.stat(this.relative(path)))?.kind ?? null;
  }

  private async resolveFile(path: string): Promise<Esbuild.OnResolveResult | undefined> {
    const kind = await this.kind(path);
    if (kind === "file") return { path, namespace: "file" };
    for (const ext of extensions)
      if ((await this.kind(path + ext)) === "file") return { path: path + ext, namespace: "file" };
    if (kind === "directory") {
      const manifest = await this.readJson(`${path}/package.json`);
      const main = typeof manifest?.main === "string" ? manifest.main : "index";
      const resolved = await this.resolveFile(join(path, main));
      if (resolved) return resolved;
      for (const ext of extensions)
        if ((await this.kind(`${path}/index${ext}`)) === "file")
          return { path: `${path}/index${ext}`, namespace: "file" };
    }
    return undefined;
  }

  private async readJson(path: string): Promise<Record<string, unknown> | null> {
    if ((await this.kind(path)) !== "file") return null;
    try {
      return JSON.parse(await this.sandbox.readText(this.relative(path)));
    } catch {
      return null;
    }
  }

  /** Node package resolution for bare imports the guest's plugins left alone. */
  private async resolvePackage(
    specifier: string,
    from: string,
    browser: boolean,
  ): Promise<Esbuild.OnResolveResult | undefined> {
    const segments = specifier.split("/");
    const name = specifier.startsWith("@")
      ? segments.slice(0, 2).join("/")
      : (segments[0] ?? specifier);
    const subpath = `.${specifier.slice(name.length)}`;
    let directory = from;
    while (true) {
      const candidate = `${directory}/node_modules/${name}`;
      if ((await this.kind(candidate)) === "directory") {
        const manifest = await this.readJson(`${candidate}/package.json`);
        if (!manifest) return this.resolveFile(join(candidate, subpath));
        const conditions = browser
          ? ["browser", "import", "module", "default"]
          : ["node", "import", "module", "default"];
        let target: string | undefined;
        try {
          if (manifest.exports !== undefined) {
            const found = resolveExports(
              manifest as Parameters<typeof resolveExports>[0],
              subpath,
              {
                browser,
                conditions,
                unsafe: true,
              },
            );
            target = found?.[0];
          } else if (subpath === ".") {
            target = resolveLegacy(manifest as Parameters<typeof resolveLegacy>[0], {
              browser,
              fields: ["module", "main"],
            }) as string | undefined;
          }
        } catch {
          target = undefined;
        }
        if (target === undefined && subpath !== ".") target = subpath;
        if (typeof target === "string") {
          const resolved = await this.resolveFile(join(candidate, target));
          if (resolved) return resolved;
        }
        return this.resolveFile(candidate);
      }
      if (directory === "/" || !directory) return undefined;
      directory = dirname(directory);
    }
  }
}

function serializeError(error: unknown) {
  const value = error as { message?: string; errors?: unknown[]; warnings?: unknown[] } | null;
  return {
    message: value?.message ?? String(error),
    errors: Array.isArray(value?.errors) ? value.errors : undefined,
    warnings: Array.isArray(value?.warnings) ? value.warnings : undefined,
  };
}
