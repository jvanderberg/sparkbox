# Benchmark: Oak Park Transit

The reference build used to judge changes to Sparkbox's agent prompt and model.

- **Reference app:** `/Users/joshv/projects/oak-park-transit` on the M1 MacBook Pro (local git repository, not pushed). Built on 2026-10-07 by a Claude Fable 5.1 agent launched through Paseo, with full network and npm, from the exact Sparkbox preamble saved as `SPARKBOX_PROMPT.md` in that directory. Its `BUILD_LOG.md` records steps, decisions, what the screenshots verified and what was left unverified.
- **Task:** a live transit dashboard and map for Oak Park, Illinois: CTA Green and Blue Line stations, the Metra UP-West station, CTA and Pace bus routes clipped to the village, a snapshot of real Train Tracker arrivals (the key worked; the Bus Tracker key did not), shadcn/ui components, Leaflet with OpenStreetMap, a bottom sheet on phones and a sidebar on desktop, system light/dark, Playwright screenshots at 390x844, 360x740 and 1280x800 in both schemes.
- **Outcome:** two commits, Biome/tsc/build clean, screenshots clean, documented gaps (no Metra alignment, Metra marker overlaps Harlem/Lake at default zoom, live adapter needs a CORS proxy, ~530 kB bundle).

## How to compare

Give the same brief (the Requirements section of `/tmp/oak-park-transit-task.md` as recorded in the build log) to a Sparkbox project with the provider under test, then compare against the reference on: data correctness (`data/SOURCES.md` present, real coordinates, no invented live data), mobile rules (overflow, 44 px targets, panel scrolling), both color schemes, honest reporting of what was verified, and build cleanliness. Sparkbox's agent lacks npm installs without the relay and uses the preview tool instead of Playwright; score those differences as environment, not model.
