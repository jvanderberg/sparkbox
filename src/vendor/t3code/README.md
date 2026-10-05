# T3 Code chat UI source

This directory was carried over unchanged from Civic Spark, which ported it from upstream. The notes below describe that port; in Sparkbox the transport is the in-browser runner (`src/agent/runner.ts`) rather than a Sprite WebSocket.

Upstream: [pingdotgg/t3code](https://github.com/pingdotgg/t3code/tree/b12c92f695a6b12116fb2cda40d610bdbe2a9566), pinned commit `b12c92f695a6b12116fb2cda40d610bdbe2a9566`.

Activity indicators were additionally checked against upstream commit [`f8500f11271622ed82df7f6c1d7f73eddb4f43e6`](https://github.com/pingdotgg/t3code/tree/f8500f11271622ed82df7f6c1d7f73eddb4f43e6).

Copyright (c) 2026 T3 Tools Inc. MIT license is included in `LICENSE.txt`.

## Source map

| Local code | Upstream source | Adaptation |
| --- | --- | --- |
| `Button.tsx` | `apps/web/src/components/ui/button.tsx` | Original button variants/sizes/classes; native React button replaces Base UI polymorphic rendering. |
| `../../AgentImages.tsx`, `../../agent-images.css` | `apps/web/src/components/chat/ChatComposer.tsx` at the pinned commit | Compact image thumbnails, native picker and named remove actions; 44px touch controls, bounded private agent transport. |
| `ComposerSurface.tsx` | `apps/web/src/components/chat/ComposerSurface.tsx` | Original surfaces, 22px corners, glass/outline/attachment geometry and classes. Import paths changed. |
| `ComposerBanner.tsx` | `apps/web/src/components/chat/ComposerBanner.tsx` | Original `Surface`, `Attachment`, `Root` and color definitions. Unused disclosure helpers omitted. |
| `ComposerPrimaryActions.tsx` | `apps/web/src/components/chat/ComposerPrimaryActions.tsx` | Original send/stop markup, sizes, colors, labels and interactions, including upstream's pairing of the stop control with the send control while a turn runs and its `Queue message` label for that send. Civic Spark state props replace T3 session state; plan, worktree and multi-question pending actions are omitted, and the pair is wrapped in upstream's `gap-1.5` row because this footer uses space-between. Like upstream, the stop control is never disabled and has no stopping spinner. |
| `QueuedMessageRow.tsx` | `MessagesTimeline.tsx`, `QueuedMessageTimelineRow` | Original dashed right-aligned bubble, attachment line, clock `Queued` label and `icon-micro` `ghost-muted` Send now / Cancel actions. Native `title` plus screen-reader text replaces the tooltip provider, because ARIA names are not exposed on a plain span. Civic Spark has no file, terminal, annotation or review-comment context and no held message, so those counts and the `Waits for Send now` status are omitted. |
| `SimpleWorkEntryRow.tsx` | `apps/web/src/components/chat/MessagesTimeline.tsx`, `SimpleWorkEntryRow` | Original row geometry, icon size, muted labels, chevron and expanded-result styles. Native button replaces T3's keyboard-enabled div; Civic Spark tool payload adapter supplies label/result. |
| `MessageCopyButton.tsx` | `apps/web/src/components/chat/MessageCopyButton.tsx` | Same copy/check icon action. Native clipboard, accessible label/title and two-second reset replace app toast/tooltip providers. |
| `MarkdownCodeBlock.tsx` | `apps/web/src/components/ChatMarkdown.tsx`, `MarkdownCodeBlock` | Original header/container/wrap/copy structure and classes. Language text replaces Pierre language-icon lookup. Code is rendered with the upstream Shiki WASM highlighter and Pierre palettes; token nodes go through React rather than raw HTML injection. |
| `syntaxHighlighting.ts`, `incrementalHighlighting.ts`, `diffTheme.ts` | `lib/syntaxHighlighting.ts`, `lib/incrementalHighlighting.ts`, `lib/diffRendering.ts` | Source helpers retain WASM selection, per-language loading cache, streaming grammar state and `pierre-light` / `pierre-dark` palettes. |
| `HighlightedCode.tsx`, `HighlightedCodeLines.tsx` | `ChatMarkdown.tsx` `UncachedShikiCodeBlock`, `chat/HighlightedCodeLines.tsx` | Same incremental tokenization and stable completed lines. Effect-based loading preserves readable plaintext while the engine loads; generated token HAST is rendered through React. Unknown/failed grammars fall back to text. |
| `QuestionOptions.tsx` | `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx` | Original option markup/classes, number shortcuts, selected check and 200ms single-choice submission. Single-choice requests map to the existing Civic Spark text-answer protocol. |
| `markdown.css` | `apps/web/src/index.css`, Markdown rules | Original paragraph, heading, list, quote, inline-code, link and fenced-code CSS. |
| `AgentTimeline.tsx` | `MessagesTimeline.tsx`, user/assistant rows and metadata | Original right-aligned 80% user bubble, assistant spacing and hover-copy metadata. Transport events replace T3 timeline types. No invented completion or cost rows. |
| `WorkingIndicator.tsx`, `visibleAnimation.ts`, activity styles in `styles.css` | `MessagesTimeline.tsx` `WorkingTimelineRow`, `WorkingTimer`, `ThinkingTimelineRow`, `LiveActivityRow`, `ActivityShimmerOverlay`; `lib/visibleAnimation.ts`; `index.css` activity utilities | Self-ticking elapsed header after the latest user, Thinking brain/spotlight, latest-tool label shine, upstream 2.2-second animation/masks and viewport/document/reduced-motion suspension. Civic Spark has no setup/compaction event, so those variants are omitted. Runtime timestamps survive reconnect; older runtimes retain the upstream unknown-time fallback plus animated activity. |
| `Agent.tsx` | `MessagesTimeline.tsx` empty row; `ChatComposer.tsx` composer body/footer | Original centered empty-state wording, 768px content width and composer spacing. Plain textarea replaces T3's Lexical editor because mention/skill/command transport is not implemented. |
| chat styles in `styles.css` | `apps/web/src/index.css` default theme | T3 light and dark neutral tokens scoped to the agent. System theme comes from Civic Spark's theme adapter. |

`WorkGroupToggleTimelineRow.tsx` and `ComposerPendingApprovalPanel.tsx` remain earlier upstream extractions. They are not rendered by the current tool-row and bypass-permissions UI.

## Integration boundaries

Send now on a queued row is upstream's steer action, with one behavioral difference. Upstream dispatches the message into the running turn at its next tool boundary; each Civic Spark turn is a single harness request, so Send now stops the running turn and the server sends that message as the next prompt as soon as the stop lands, exactly once, leaving the rest of the queue in order. The queue itself lives with the runner rather than in a browser store, so it survives a reload and a second browser, and Stop clears it while the client returns its text and images to the composer.

The participant's workspace header, provider selector (GLM / Opus 5.5), key/workspace-ID connection form, dirty-file safeguard, session replay/reconnect and Sprite transport are Civic Spark's integration. Connection notices use T3's actual attached composer surface. All coding tools remain in bypass mode; human questions remain interactive.

This is a source-based port of the supported chat UI, not the entire T3 Code application. T3's desktop shell, provider account manager, virtualized history, Lexical mention/skill commands, attachments, plan/draft queues, revert checkpoints and rich media are not claimed or shown as available. Native clipboard/title replace framework-specific tooltip/toast providers. Message timestamps are not fabricated. New running-turn events carry `workingStartedAt`, retained in server snapshots and the Sprite journal, for the live elapsed header. Completed turns keep no timer/completion/cost row. Waiting for a participant answer suppresses animation; provider failure and stop/completion clear it. Existing tool expansion is retained rather than importing T3's entire grouped-work model.

## Verification

The keyboard adaptation retains these composer surfaces, controls and send/stop behavior. Civic Spark's workspace frame follows unzoomed `visualViewport` height and offset on resize/scroll; phone controls collapse into a mounted disclosure. Mobile textarea bounds use the actual agent panel, and Latest is positioned from the measured composer height. The source comparison uses the pinned [`chat/ChatComposer.tsx`](https://github.com/pingdotgg/t3code/blob/b12c92f695a6b12116fb2cda40d610bdbe2a9566/apps/web/src/components/chat/ChatComposer.tsx) and `ComposerSurface.tsx`; no new chat interaction or completion UI is introduced. `scripts/keyboard-browser-smoke.ts` tests independent visual/layout viewport metrics with local Chromium/WebKit and mocked transports; it does not establish physical iOS keyboard behavior.

`npm run test:agent-browser` exercises the built UI with a deterministic agent socket and real local auth/workspace/file APIs: readiness, fixed models, slow first response with a ticking duration, actual animation transforms, active tool/Thinking transitions, reduced motion, restored elapsed time, terminal errors without a done event, stream assembly, Markdown tables/code, streamed syntax tokens and palette switching, copy, line wrap, tool-result expansion, safe file opening, user questions, send/stop, malformed workspace-ID prevention, reconnect/reload/project reopen, and mobile layout. No paid model call or real key is used. Screenshot artifacts are under `artifacts/agent-chat-*.png`.

`tests/agent-highlighting.test.ts` checks incremental multiline grammar against a fresh highlight, source replacement, Pierre palette differences, escaping HTML-looking code and unknown-language fallback. `@pierre/diffs` is pinned to upstream’s `1.3.0-beta.10`; its transitive Shiki packages are locked in `package-lock.json`.
