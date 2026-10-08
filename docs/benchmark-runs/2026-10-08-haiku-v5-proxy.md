# Benchmark run 5: Haiku 5.5, prompt as committed, with the host fetch proxy (2026-10-08)

Same driver, brief, model and key handling as the earlier runs; prompt as committed (the download line now says the host fetches when the browser is refused). New in the environment: `GET /api/fetch` on the host, used by the download tool as a fallback. Raw artifacts (git-ignored): `artifacts/benchmark/2026-10-08-haiku-v5-proxy/` (transcript only; stopped by hand after the first turn, see below). A first launch (`…-v5a-devserver-died/`) lost its dev server mid-turn, which took the proxy and the relay with it; that was my doing (a port-based kill of the host process also matched the dev server's open proxy connections), not the agent's.

## What the proxy changed

The CORS wall is gone for the data the brief asks for. In the first turn, 22 downloads:

| Source | Earlier runs | This run |
| --- | --- | --- |
| CTA Train Tracker, `ttarrivals.aspx` by `mapid` | refused from Node (relay allowlist) and from the browser (no CORS header); sample data in every run | one real response per station for all seven CTA stations, `errCd` 0, API timestamps 05:45 to 05:47 Chicago time, saved as raw files and built into `data/snapshot/arrivals.json` with the retrieval time by a small script, "through the host" |
| Metra GTFS `schedule.zip` | CORS-blocked | fetched (716 KB) through the host |
| CTA GTFS `google_transit.zip` | CORS-blocked | still fails: the proxy's 25 MiB cap (the zip is 68 MB); the agent fell back to the Chicago Data Portal as in runs 3 and 4 |
| Pace GTFS | guessed URLs 404 | 404 and 502 on guessed URLs; the real file is at a dated path the agent did not look up |
| Chicago Data Portal (L stops, rail lines, bus stops, bus routes) | worked from the browser | same, direct |
| Overpass | 504 and CORS failures | 500 from the mirror through the host; main endpoint still 504 |

The key never appeared in any file other than `.env.local` or in any reply; the host logged only `fetch lapi.transitchicago.com: 200`.

## Outcome

Stopped by hand after one turn of 23 minutes and 92 tool calls. The turn stored and tested the key, fetched the data above, wrote stations, rail lines, bus stops, the real arrivals snapshot and SOURCES.md, installed in two pnpm commands, wrote the adapter, UI primitives, map, panels and app, passed `tsc`, configured the preview, and then met the same environment failure as run 4: Vite started and listened, but never served `/src/main.tsx` (the probe timed out, then reported "Failed to load script"), and the next shell command hung until the driver's stall limit. A reload would have dropped `node_modules` and the model's session, so two more identical turns were not worth running.

Not assessable for this run: the rendered UI, mobile rules, schemes, build cleanliness, and the final report. Data correctness: the best of the series and, for arrivals, now equal to the reference's method (one request per `mapid`, raw responses kept, snapshot timestamped).

## Environment versus model or prompt

Environment: the preview wedge. It has now happened in the two runs whose projects pulled in Leaflet, Tailwind v3, lucide-react and shadcn-style helpers, and not in the two runs with React, Leaflet and little else; the likely culprit is dependency pre-bundling of a large package through the esbuild bridge, which is tracked in `IMPLEMENTATION_PLAN.md`. The 25 MiB proxy cap is a deliberate limit; the CTA GTFS needs an upload or a bigger cap.

Prompt: nothing new. The download line's note that the host may fetch was enough; the agent used the tool as before and read the "through the host" suffix in its outputs.

Model: Pace GTFS URLs guessed twice rather than looked up on the Pace developer page (the page itself is a normal site the proxy could have fetched).

## Timeline

| Turn | Minutes | Tool calls | What happened |
| --- | --- | --- | --- |
| 1 | 23 | 92 | Key stored and probed through the host (real arrivals); L stops, Metra GTFS, catalog searches, bus stops, rail lines, bus routes; seven Train Tracker snapshots; data files and SOURCES.md; two installs; adapter, primitives, map, panels, app; tsc clean; preview configured; Vite up but the entry never served; next command hung; driver stop; stopped by hand |
