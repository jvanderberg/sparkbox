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

## Not done

- [x] Anthropic adapter verified live on 2026-10-05 with Opus 5.5 (`npm run test:live:anthropic`): bash and text-editor tools, streamed reply, preview, changes and transcript restore after reload. Fixed a doubled-delta bug from a StrictMode double subscription.
- [x] OpenRouter adapter verified live on 2026-10-05 with `z-ai/glm-5.3-flash` (`npm run test:live:openrouter`): function tools, streamed reply, preview, changes and transcript restore.
- [ ] Live verification of the OpenAI adapter (needs a key; not run in CI).
- [ ] GitHub: connect with a token, push through the REST Git Data API, enable Pages. Changes should then compare against the last pushed commit.
- [ ] Outbound network: page-side npm installer that fetches tarballs from the registry into the sandbox, so `npm install` works without a WISP relay. The `download` tool is the first step; an installer would resolve the dependency tree and unpack into node_modules.
- [ ] Screenshots in the other color scheme (a hidden frame cannot change prefers-color-scheme; would need a CSS override hook).
- [ ] Lite mode for phones: esbuild-wasm build and preview without the Wasmer sandbox.
- [ ] A deployed demo with two hostnames (app and preview host).
- [ ] Remove the leftover Civic Spark portal CSS from `src/styles.css` and the unused `claude`/`opencode` provider names in `src/agents/protocol.ts`.
- [ ] Preview for projects that run their own dev server (expose any listening port; partly there through "Show port N").
- [ ] Reproduce the "Scheduler is dead" crash deliberately to confirm the automatic rebuild path end to end; today it is covered by code review and the recovery wrapper only.
- [ ] Explain blocked network requests in the preview (which host, why) instead of a generic module error.
- [ ] Questions from the agent to the user (the timeline supports approval events; no provider wiring yet).
