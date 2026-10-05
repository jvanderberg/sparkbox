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

## Not done

- [ ] Live verification of each provider adapter against a real account (needs keys; not run in CI).
- [ ] GitHub: connect with a token, push through the REST Git Data API, enable Pages. Changes should then compare against the last pushed commit.
- [ ] Outbound network: page-side npm installer that fetches tarballs from the registry into the sandbox, so `npm install` works without a WISP relay. Until then, document relay setup.
- [ ] Lite mode for phones: esbuild-wasm build and preview without the Wasmer sandbox.
- [ ] A deployed demo with two hostnames (app and preview host).
- [ ] Remove the leftover Civic Spark portal CSS from `src/styles.css` and the unused `claude`/`opencode` provider names in `src/agents/protocol.ts`.
- [ ] Preview for projects that run their own dev server (expose any listening port; partly there through "Show port N").
- [ ] Questions from the agent to the user (the timeline supports approval events; no provider wiring yet).
