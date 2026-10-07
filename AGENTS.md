# Sparkbox contributor guide

Sparkbox is a zero-server, browser-only derivative of Civic Spark. Keep its UI and interaction rules; the runtime is different.

- React and TypeScript throughout; npm and its lockfile; Vite; Tailwind; Biome. Strict types and explicit errors.
- **Stateless host.** The app is a static site plus one stateless process (`server/`) that holds the free agent's key, mints invite tokens, and relays sandbox networking to an allowlist. It stores no user data: tokens are signed, counters are in memory. Do not add a database, accounts or server-side files. Everything else (files, keys, transcripts) stays in the browser, and the app must keep working as a static site without the host (no free agent, no relay).
- **Keys stay in the browser.** Provider keys live in localStorage and go only to that provider. Never write them into the sandbox filesystem, project files, exports, logs or the transcript.
- **Participant code runs only in the sandbox.** The Wasmer sandbox in the page is the execution environment; the preview iframe is on a separate origin. Never execute project code in the app's own JavaScript context.
- **Use each provider's native coding tools.** Anthropic: `bash_20250124` and `text_editor_20250728`. OpenAI: `shell` and `apply_patch` on the Responses API. OpenRouter: the generic function tools. Do not invent provider-specific prompts that fight the tool schemas.
- Keep the agent chat faithful to the copied T3 Code UI. Do not add original chat UX, decorative icons, or per-turn completion/cost rows. Preserve upstream attribution in `src/vendor/t3code/README.md`.
- The runner emits the Civic Spark agent event stream (`user`, `status`, `state`, `text`, `tool`, `done`, `error`) so the timeline and tests carry over. Text deltas share an id and append; tool events share an id and replace.
- Follow the system light/dark theme throughout. Work panels fit the viewport and scroll internally.
- Mobile is a required interface. Verify at phone widths and a short viewport in both themes. Keep 44px touch targets and 16px inputs. The full sandbox may not fit on phones; report that honestly instead of hiding it.
- No silent overwrites of unsaved edits. The editor compares file revisions before saving.
- Do not run paid models in tests. Unit tests use fake providers; the browser smoke makes zero model calls.
- Run `npm run check` and `npm run test:browser` before reporting completion, and look at the screenshots in `artifacts/`.
