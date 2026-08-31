# Product media

Captured from a running Syncle instance on 31 August 2026 — not mock-ups.

A throwaway stack was stood up alongside four live databases, seeded with a
generated shop (4,820 customers, 19,400 orders, 640 products, 41,200 order
items), and four bridges were built and left running: a completed replay
backfill into MySQL, a CDC bridge into MongoDB, a watch bridge polling
`updated_at`, and a CDC bridge warming a Redis price cache. Every number on
screen is a real delivery count from that run.

Nothing here is anyone's data. Names are assembled from common name parts and
every address is on `example.com`, the reserved domain.

Images are 1600px wide — twice the width they are usually displayed at, so
they stay sharp on high-density screens without carrying 3200px files in git.

## Stills

| File | What it shows | Where it earns its place |
| --- | --- | --- |
| `01-bridge-live-cdc.png` | A CDC bridge running at 100% success, and the rows that crossed it | **The hero.** README, above the fold |
| `02-bridge-feed.png` | The same deliveries as a newest-first stream | Alternate hero; docs |
| `03-bridge-backfill.png` | A completed replay — 5,690 rows, zero failures, per-row timings | README, on delivery guarantees |
| `04-workspace-map.png` | One source fanning out to four bridges and four destinations | **Website.** Explains the product in one image |
| `05-bridge-builder.png` | Column selection, live preview, trigger config, sample payload | Website, "build it visually"; docs/bridges |
| `06-workbench-data.png` | Browsing 5,060 rows with the schema tree beside them | Website, workbench section |
| `07-workbench-structure.png` | Column types, defaults, keys and indexes | docs/workbench |
| `08-workbench-query.png` | The SQL editor with a real result set, 11 ms | Website, workbench section |
| `09-workbench-diagram.png` | The ER diagram with foreign keys drawn | Website, workbench section |

## Motion

| File | Length | Use |
| --- | --- | --- |
| `syncle-demo.mp4` | 46 s · 1600×1000 · 2.8 MB | The full run: the workspace map, opening a live CDC bridge, rows inserted into Postgres arriving while you watch, the feed, then those same rows sitting in MongoDB. For the website, a Show HN post, or social. |
| `syncle-live-sync.gif` | 12 s · 900px · 2.2 MB | The moment that matters, on a loop: the delivered counter climbing as rows land. For the README, where a GIF plays and an MP4 does not. |

The inserts in the video are fired from outside the browser while the page is
open, so the counter moving on screen is the bridge actually working. There are
no cuts and nothing is sped up.

## One caveat

The map and diagram shots include the fix from #51 (React Flow's controls
render as a white block with invisible icons in dark mode). The published 1.2.0
image still has that bug, so those two images match the app **once #51 merges**.
Everything else is stock 1.2.0.

## Re-shooting after a UI change

The capture is scripted — a compose file for the four databases and a separate
Syncle instance, a seed SQL file, and Playwright scripts that drive the real UI
and wait on real text before each frame. They live outside this repo today; say
the word and they can land under `scripts/demo/` so this is one command to
repeat.
