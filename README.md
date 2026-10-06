# Sparkbox

An AI coding agent, a Linux sandbox and a live preview, all running in your browser. No server, no install.

Sparkbox is derived from [Civic Spark](https://github.com/jvanderberg/civic-spark), the hackathon workspace platform. It keeps Civic Spark's workspace experience (the T3 Code chat UI, file explorer, Monaco editor, changes view and mobile layout) and replaces the Sprite runtime and management server with pieces that live in the page:

| Civic Spark | Sparkbox |
| --- | --- |
| Fly Sprite per workspace | [Wasmer](https://github.com/wasmerio/wasmer-sdk) WASIX sandbox in the page: bash, coreutils, Node.js via Edge.js |
| Claude Code / OpenCode runner inside the Sprite | A small agent loop in the page using each provider's native coding tools |
| Management server, email sign-in, Git on the host | Nothing. Files live in IndexedDB; keys live in localStorage |
| Managed preview URL | A static server inside the sandbox, served through a service worker on a second origin |

## Providers

| Provider | Tools the model uses | Key |
| --- | --- | --- |
| Anthropic | `bash` and the `text_editor` tool | Paste an API key |
| OpenAI | `shell` and `apply_patch` (Responses API) | Paste an API key |
| OpenRouter | Function tools (`run_command`, `read_file`, `write_file`, `edit_file`, `list_files`) | Sign in with OpenRouter (OAuth PKCE) or paste a key |

Keys are stored only in this browser and are sent only to that provider. All three providers accept browser requests directly, so no proxy is involved. Usage is billed to the user's own account.

## Run it

```sh
npm install
npm run dev
```

Open http://127.0.0.1:4320. The preview is served from http://localhost:4320, which the browser treats as a second origin; both are the same Vite server.

Create a project, add a key in the Agent panel's Connection settings, and ask for something. Preview starts a static server inside the sandbox and shows `index.html`.

## What works today

- Sandbox boot with persistent project files across reloads (IndexedDB snapshot of `/workspace`).
- Agent turns against Anthropic, OpenAI and OpenRouter with streaming text, live tool rows, message queueing and Stop.
- Files, editor with save conflict detection, upload/download, Changes against a saved version, and Preview with an iframe and logs.
- Phone layout with the Civic Spark mobile rules.

## Limits

- **No outbound network from the sandbox** unless a WISP relay URL is set in Settings. `npm install` and `curl` fail without one. The starter template needs no install step, and the agent is told to build apps that load libraries from a CDN in the preview instead.
- **Only the Anthropic adapter has been run live.** `npm run test:live:anthropic` with `SPARKBOX_ANTHROPIC_KEY` set makes one paid Claude turn through the UI. The OpenAI and OpenRouter adapters typecheck against the official SDKs but have not been run against live accounts yet.
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
