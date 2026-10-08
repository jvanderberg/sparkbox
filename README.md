# Sparkbox

An AI coding agent, a Linux sandbox and a live preview, all running in your browser. No server, no install.

Sparkbox is derived from [Civic Spark](https://github.com/jvanderberg/civic-spark), the hackathon workspace platform. It keeps Civic Spark's workspace experience (the T3 Code chat UI, file explorer, Monaco editor, changes view and mobile layout) and replaces the Sprite runtime and management server with pieces that live in the page:

| Civic Spark | Sparkbox |
| --- | --- |
| Fly Sprite per workspace | [Wasmer](https://github.com/wasmerio/wasmer-sdk) WASIX sandbox in the page: bash, coreutils, Node.js via Edge.js |
| Claude Code / OpenCode runner inside the Sprite | A small agent loop in the page using each provider's native coding tools |
| Management server, email sign-in, Git on the host | Nothing. Files live in IndexedDB; keys live in localStorage |
| Managed preview URL | A static server inside the sandbox, served through a service worker on a second origin |

## Agent tools

Besides each provider's native file and shell tools, the agent gets two tools that run in the page rather than in the sandbox:

- **download**: fetches a URL with the browser and saves it into the project. Works wherever the server allows cross-origin reads (open-data portals, GitHub raw files, npm, CDNs). When the browser is refused and the browser holds an invite, the host's fetch proxy (`GET /api/fetch?url=…`) fetches it instead: GET only, no cookies, private addresses refused, 25 MiB cap, counted against the invite's daily relay budget, URLs never logged. Without a host, the agent asks for an upload.
- **preview**: looks at the running app. Formats: a screenshot at phone, tablet or desktop size in a chosen color scheme, a text outline of headings, links, buttons, inputs, images, stylesheets, scheme and overflow, the current HTML, or the page errors on a fresh load plus those the user hit. Screenshots are painted by the browser from the live DOM through an SVG (modern-screenshot, with html2canvas as fallback) in a probe frame kept inside the viewport so animations finish; the probe forces `prefers-color-scheme` by patching `matchMedia`, the root `color-scheme` and media rules. Screenshots go back to Claude and OpenAI inside the tool result and to OpenRouter models as a follow-up user message. `scripts/preview-tool-check.ts` compares them with a native capture of a Leaflet map.

## Providers

| Provider | Tools the model uses | Key |
| --- | --- | --- |
| Anthropic | `bash` and the `text_editor` tool | Paste an API key |
| OpenAI | `shell` and `apply_patch` (Responses API) | Paste an API key |
| OpenRouter | Function tools (`run_command`, `read_file`, `write_file`, `edit_file`, `list_files`) | Sign in with OpenRouter (OAuth PKCE) or paste a key |

Keys are stored only in this browser and are sent only to that provider. All three providers accept browser requests directly, so no proxy is involved. Usage is billed to the user's own account.

## Project secrets

API keys and tokens the app itself needs (a transit API key, say) go under Settings → Secrets while a project is open, not into the chat. They stay in this browser's localStorage, become environment variables in every command and in the preview server (so Vite exposes `VITE_`-prefixed ones to the page), can be written as `${NAME}` in download tool URLs, and are redacted to `[NAME]` in every tool output the model sees. The agent is told the names only.

## Hosted on Fly

The deployed site is https://sparkbox.fly.dev. One small Fly machine runs `server/main.ts`, which:

- serves the built app on port 8080 (public 443) and the preview host on port 8081 (public 8443, a second origin for the sandbox's service worker);
- publishes `/config.json` so the app learns the preview origin, the relay URL and whether the free agent is on;
- mints signed invite tokens at `POST /api/invite` from `SPARKBOX_INVITE_CODES`;
- proxies the **Sparkbox** provider at `/api/agent/chat/completions` to OpenRouter with the server-held key, a fixed cheap model (`SPARKBOX_FREE_MODEL`, default Claude Haiku 5.5) and daily limits per token and overall; a request over `SPARKBOX_AGENT_BODY_BYTES` (default 32 MB, Anthropic's own request limit; the body is the whole conversation with its screenshots) gets a 413 with a message rather than a dropped connection;
- relays WISP at `/wisp/<ticket>/` so the sandbox gets outbound TCP to any public host on ports 80 and 443. The destination is read from each stream's TLS server name or Host header, resolved on the host, refused when internal or private, and the connection is pinned to that address; `SPARKBOX_RELAY_ALLOWLIST` narrows it to named hosts. The relay is meant to be hard to borrow from outside Sparkbox rather than impossible: the upgrade must come from the app's origin (`SPARKBOX_RELAY_ORIGINS` adds more), the URL carries a one-day ticket from `POST /api/relay` rather than the invite token, each invite may hold a few connections (`SPARKBOX_RELAY_CONNECTIONS`, default 8) with a stream cap each (`SPARKBOX_RELAY_STREAMS`, default 256; a polling app that fetches many stops at once needs a wide cap), streams that never name a destination are dropped after 30 s, and bytes count against the invite's daily budget;
- fetches URLs for the download tool at `/api/fetch` when a site sends no CORS headers (token required, GET only, public hosts only, size cap, same daily byte budget as the relay).

It stores nothing. Tokens are HMAC-signed, counters live in memory, and the machine stops when idle (`auto_stop_machines`). Secrets: `SPARKBOX_TOKEN_SECRET`, `SPARKBOX_INVITE_CODES`, `SPARKBOX_OPENROUTER_KEY`. Deploy with `fly deploy --remote-only --ha=false`. Static-only hosting (no server) still works; the app then has no free agent and no relay, and the preview origin must be set in Settings.

Locally, `npm run dev:server` runs the same process on port 4330 behind Vite's proxy with the relay URL pointing back at the dev server (set `SPARKBOX_TOKEN_SECRET`, `SPARKBOX_INVITE_CODES` and optionally `SPARKBOX_OPENROUTER_KEY` in the environment); see `scripts/host-smoke.ts` for the end-to-end check. A second checkout can run beside the first by setting `SPARKBOX_DEV_PORT` and `SPARKBOX_HOST_PORT` for Vite and matching `PORT` and origins for the host. Invites are limited to 30 per address per day, so repeated browser checks eventually need a restart of the host process.

## Run it

```sh
npm install
npm run dev
```

Open http://127.0.0.1:4320. The preview is served from http://localhost:4320, which the browser treats as a second origin; both are the same Vite server.

Create a project, add a key in the Agent panel's Connection settings, and ask for something. Preview starts a static server inside the sandbox and shows `index.html`.

## What works today

- Sandbox boot with persistent project files across reloads (IndexedDB snapshot of `/workspace`). The page keeps its own copy of the files, so the save issued when the tab is hidden or reloaded is complete and needs no sandbox round trip; `node_modules` and build output are never saved, and the preview says so when they are missing.
- Agent turns against Anthropic, OpenAI and OpenRouter with streaming text, live tool rows, message queueing and Stop.
- Files, editor with save conflict detection, upload/download, Changes against a saved version, and Preview with an iframe, logs, Reload, Restart and a Server form.
- Preview runs the command in the project's `sparkbox.json` (command, port, directory); without one it is a static server with live reload. The command runs under a small Node supervisor (`src/sandbox/supervise-script.ts`) that records every Node process it starts and kills them all on Stop, so `node server.js & node .sparkbox/vite.mjs` never leaves a server holding its port. Same-origin WebSockets from preview pages are tunnelled through a bridge process in the sandbox (`scripts/ws-smoke.ts`). Backends run on one port; SQLite through sql.js.
- Real Vite 7 inside the sandbox (`scripts/vite-smoke.ts`). The sandbox runtime cannot run esbuild, Rollup's parser or WebAssembly, so `.sparkbox/vite.mjs` patches the installed Vite once to load replacements: esbuild calls are forwarded over the process's stdio to esbuild-wasm running in the page (`src/preview/esbuild-service.ts`), which reads and writes project files through the sandbox filesystem and calls plugin hooks back in the sandbox; Rollup's parser becomes acorn and the import lexer its asm.js build. File watching is event-driven: the page reports the exact paths it writes, diffs the workspace after each shell command, and the dev server only falls back to a slow content scan for processes that write files on their own. Vite 8 (Rolldown) is not supported yet.
- Phone layout with the Civic Spark mobile rules.

## Limits

- **Outbound network from the sandbox** goes through the host's WISP relay when the browser holds an invite token (the app mints a one-day relay ticket at sandbox boot; a session that outlives it loses the network until the page reloads), or a relay URL set in Settings. Without either, `npm install` and `curl` fail. The relay reaches any public host on 80/443, so a Node server in the sandbox can proxy live APIs for the page. The starter template needs no install step, and the agent is told to build apps that load libraries from a CDN in the preview instead. The preview page itself does reach the internet: the Wasmer service worker is patched at build time so cross-origin requests bypass the sandbox and guest responses use `Cross-Origin-Embedder-Policy: credentialless` (see `vite.config.ts`). Safari lacks `credentialless`, so the agent is told to add `crossorigin` attributes to CDN tags.
- **Shell tools:** bash, coreutils, grep, sed, ripgrep, Node.js, npm and pnpm. No git, curl or python. Output that Node writes into a shell pipe is lost in this runtime (`node x.js | head` prints nothing); redirect to a file instead. An unhandled promise rejection in guest Node code (Edge.js) reaches the SDK worker's global handler rather than Node's; unpatched, the SDK then closes its worker pool and every later process hangs. The build and the dev server patch the worker (`vite.config.ts`) to log guest rejections to the browser console and let the process continue, so a script whose promise rejects ends with no output instead of an error. Should the pool still die, every spawn and wait has a deadline and a page error triggers a probe; a hang rebuilds the runtime from the files in memory and says so in the command's output (dependencies must then be reinstalled and the preview started again). `npm run test:vite` checks that a guest rejection leaves the runtime and the dev server running.
- **Page errors reach the agent.** The preview's static server injects a small reporter into HTML pages; runtime errors show in the Preview panel and are included in the agent's next prompt.
- **Anthropic and OpenRouter have been run live; OpenAI has not.** `npm run test:live:anthropic` and `npm run test:live:openrouter` (with `SPARKBOX_ANTHROPIC_KEY` / `SPARKBOX_OPENROUTER_KEY` set) each make one paid turn through the UI. The OpenAI adapter typechecks against the official SDK but has not been run against a live account yet.
- **Preview needs a second origin.** Locally that is `localhost` vs `127.0.0.1`. A static deployment needs two hostnames serving the same build, set in Settings → Preview origin. GitHub Pages project sites share one origin, so use Cloudflare Pages or similar with two custom domains, or a separate host for the preview files (`wasmer-service-worker.js` and `.wasmer/`).
- **Cross-origin isolation is required.** The dev server and `public/_headers` set the headers. Hosts that cannot set headers need the coi-serviceworker shim.
- The full sandbox wants a desktop-class browser. Phones run the UI, but memory headroom for Wasmer on iOS is unverified.
- No Git yet. Changes compares against the last Save version. GitHub publishing is planned.
- Browser storage is evictable. Download or publish anything you care about.

## Checks

```sh
npm run check         # lint, typecheck, unit tests, build
npm run test:browser  # Playwright: sandbox boot, preview, editor, changes; desktop and phone
```

## Credits

The chat UI is a source port of [T3 Code](https://github.com/pingdotgg/t3code) (MIT), carried over from Civic Spark; see `src/vendor/t3code/README.md`. Sandbox by [Wasmer](https://wasmer.io) (MIT).
