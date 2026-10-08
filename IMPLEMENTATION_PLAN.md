# Implementation plan

Status as of 2026-10-05. Prototype only.

## Done

- [x] Repository scaffold from Civic Spark's web app: T3 Code chat port, timeline, file explorer, Monaco editor, changes view, theme, mobile CSS, viewport hook.
- [x] Wasmer sandbox adapter (`src/sandbox/wasmer.ts`): bash + Edge.js packages, shell execution with streaming output, filesystem API, IndexedDB persistence of `/workspace`, port exposure.
- [x] In-browser agent runner (`src/agent/runner.ts`) emitting the Civic Spark event protocol; queue, steer, stop, transcript and session persistence.
- [x] Provider sessions: Anthropic (bash + text editor), OpenAI Responses (shell + apply_patch with a V4A patch applier), OpenRouter (function tools). OpenRouter OAuth PKCE sign-in.
- [x] Preview: static server script run by Edge.js inside the sandbox, exposed through the Wasmer service worker on a second origin; Vite plugin serves the host files in dev and emits them in the build.
- [x] Projects home, settings (preview origin, WISP relay), starter template.
- [x] Unit tests: patch parser/applier, tools, changes diffing, runner sequence/queue/stop/failure. Browser smoke on desktop and a Pixel 7 profile in dark mode.

- [x] Preview can load CDN libraries and map tiles (2026-10-06): the SDK service worker forwarded every request into the sandbox and forced `require-corp` on the preview document; both are patched in the Vite plugin, verified by the browser smoke (fetch, dynamic import, classic script) and a live OpenRouter Leaflet turn.
- [x] Runtime recovery: a dead Wasmer scheduler triggers a sandbox rebuild from the in-memory files, with the preview reset. Files are also flushed to IndexedDB after every agent turn and when the tab is hidden.
- [x] Page errors from the preview are captured through an injected reporter and shown in the panel and the agent prompt. grep, sed and ripgrep added; guidance lists what exists.

- [x] Agent preamble ported from Civic Spark's workspace guidance (2026-10-06).
- [x] Page-side tools (2026-10-06): `download` saves URLs into the project through the browser's fetch; `preview` returns screenshots at phone/tablet/desktop sizes, a text outline, HTML or errors from hidden probe frames served by the same sandbox. Covered by unit tests and the browser smoke.

- [x] Hosted on Fly (2026-10-07): `server/main.ts` serves the app and the preview host (port 8443 as the second origin), publishes `/config.json`, mints invite tokens, proxies the free "Sparkbox" provider to OpenRouter with a server key and daily limits, and relays WISP with a TLS-server-name allowlist. Verified locally end to end (`scripts/host-smoke.ts`): invite, proxied model turn, registry fetch and `pnpm add` through the relay, blocked host refused.

- [x] Same-origin WebSockets from preview pages (2026-10-07): the injected bridge shim posts socket operations to the Sparkbox tab, which relays them to a bridge process in the sandbox holding real sockets. Verified by `scripts/ws-smoke.ts` locally and on Fly.
- [x] Vite 7 dev server inside the sandbox (2026-10-07): Edge.js cannot execute WebAssembly or native binaries, so `.sparkbox/vite.mjs` rewrites the installed Vite to use an esbuild client that forwards calls over stdio to esbuild-wasm in the page (plugin hooks are called back in the sandbox, files go through the sandbox filesystem), acorn for Rollup's parser and the asm.js import lexer. Watching is event-driven (exact paths from the page, a workspace diff after each shell command, a ten-second content scan only as a fallback). Verified by `scripts/vite-smoke.ts`: config bundling, TypeScript entry, CSS hot update without reload, React pre-bundling, Fast Refresh with state preserved for page and shell edits.

- [x] Prompt benchmark (2026-10-08): `scripts/benchmark-run.ts` drives the in-page agent through the real UI on the Oak Park transit brief (`docs/benchmark.md`, reports in `docs/benchmark-runs/`). The baseline run never got the app running; the prompt now states what the relay reaches, which native tools do not run, that the Vite launcher appears when the preview starts and that `vite build` cannot run from a shell, that data typed from memory is invented, and when to stop and report. Found and fixed on the way: the preview probe's forced light/dark schemes were inverted by an extra escape level in the bridge script (the browser smoke now asserts on the rendered background), and exports under `artifacts/` triggered dev-server reloads.

- [x] Open relay (2026-10-08): the WISP relay reaches any public host on 80/443 instead of a registry allowlist, because projects need live APIs (CTA refused the Oak Park app). Abuse is made inconvenient rather than impossible: the destination name is resolved on the host and private or internal answers are refused with the connection pinned to the vetted address; the upgrade must carry the app's Origin; the URL holds a one-day relay ticket (`POST /api/relay`, scoped signature) instead of the invite; connections per invite and streams per connection are capped; bytes count against the daily budget. `SPARKBOX_RELAY_ALLOWLIST` restores a named allowlist. The prompt now tells the agent to proxy CORS-blocked APIs through a sandbox server.
- [x] Fetch proxy on the host (2026-10-08): `GET /api/fetch?url=…` fetches a URL for the download tool when the site sends no CORS headers (invite token, GET only, public hosts only including through redirects, 25 MiB cap, the relay's daily byte budget, URLs never logged). The tool tries the browser first and falls back when a host is configured. Unit tests in `tests/fetch-proxy.test.ts`; checked end to end by `scripts/host-smoke.ts`.

## Not done

- [x] Anthropic adapter verified live on 2026-10-05 with Opus 5.5 (`npm run test:live:anthropic`): bash and text-editor tools, streamed reply, preview, changes and transcript restore after reload. Fixed a doubled-delta bug from a StrictMode double subscription.
- [x] OpenRouter adapter verified live on 2026-10-05 with `z-ai/glm-5.3-flash` (`npm run test:live:openrouter`): function tools, streamed reply, preview, changes and transcript restore.
- [ ] Live verification of the OpenAI adapter (needs a key; not run in CI).
- [ ] GitHub: connect with a token, push through the REST Git Data API, enable Pages. Changes should then compare against the last pushed commit.
- [ ] Page-side npm installer for static hosting without the relay (the `download` tool is the first step).
- [x] Screenshots in either color scheme (2026-10-06): the probe frame forces the scheme through matchMedia, root color-scheme and media-rule rewriting. Rendering switched to modern-screenshot so transforms (map panes) land exactly; verified against a native capture.
- [ ] Lite mode for phones: esbuild-wasm build and preview without the Wasmer sandbox.
- [x] Production smokes pass against https://sparkbox.fly.dev (2026-10-07): browser smoke on desktop and phone with the :8443 preview host, and host smoke (invite, proxied free-agent turn, registry fetch and pnpm add through the relay, blocked host refused). A Vite plugin now emits the SDK's worker and wasm with their layout intact; without it every sandbox process died in the production bundle.
- [ ] Remove the leftover Civic Spark portal CSS from `src/styles.css` and the unused `claude`/`opencode` provider names in `src/agents/protocol.ts`.
- [ ] Vite 8 (Rolldown) in the sandbox: needs the two-way plugin callbacks bridged to Rolldown's browser build; Vite 7 is pinned until then.
- [ ] Tailwind v4 in the sandbox: its core is JavaScript but Lightning CSS and the Oxide scanner are native; run them in the page through the same channel.
- [x] Sandbox hangs (2026-10-08): the cause is an exception that escapes the guest's JavaScript runtime (for example Rollup's native loader during a raw `vite build`) and crashes the SDK worker; the SDK closes its pool and every later spawn hangs instead of failing, so the dead-runtime recovery never ran. Node's own options cannot intercept it (the rejection reaches the worker before Node's handlers), so `vite.config.ts` patches the SDK worker in dev and build to log guest rejections and let the process continue; a raw `vite build`, a script whose fetch rejects, and a rejection inside the Vite dev server no longer touch the runtime. As a second line, every spawn and wait has a deadline (`src/sandbox/deadline.ts`), a page error triggers a probe, and a hang rebuilds the runtime and tells the agent to reinstall dependencies and restart the preview. `scripts/vite-smoke.ts` checks the prevention end to end.
- [ ] Still open from the benchmark: the provider session is persisted only when a turn ends, so a reload after a stuck turn reverts the model's memory to the previous turn; a runtime rebuild drops node_modules (keeping them would need the in-memory snapshot to include dependencies).
- [ ] Reproduce the "Scheduler is dead" crash deliberately to confirm the automatic rebuild path end to end; today it is covered by code review and the recovery wrapper only.
- [ ] Explain blocked network requests in the preview (which host, why) instead of a generic module error.
- [ ] Questions from the agent to the user (the timeline supports approval events; no provider wiring yet).
