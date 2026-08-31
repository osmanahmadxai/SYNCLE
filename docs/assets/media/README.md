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

Images are 1600px wide — twice the width they are usually displayed at, so they
stay sharp on high-density screens without carrying 3200px files in git.

---

## Motion

**`syncle-live-sync.gif`** — 10 s · 800px · 1.4 MB. The payoff on a loop: a
bridge built seconds earlier delivering its first rows, the counter climbing
from zero. Used in the project README, where a GIF plays and an MP4 does not.

<img src="syncle-live-sync.gif" width="100%" alt="A newly built Syncle bridge delivering its first rows as the counter climbs">

**`syncle-demo.mp4`** — 70 s · 1600×1000 · 4.5 MB. The whole job, start to
finish, with nothing skipped:

1. An empty workspace, then **New bridge**.
2. Naming it, and picking the source — connection, database, then `public.orders`
   — with a live preview of the real rows and every column selectable.
3. Choosing **Live bridge → Event-based (real-time)**, the insert/update/delete
   operations, and running the CDC readiness check.
4. Pointing the destination at **MongoDB**, naming the target collection.
5. **Create bridge**, then **Start listening**.
6. Orders inserted into Postgres from outside the browser — the counter climbs
   and the rows appear as they cross.
7. The MongoDB collection that did not exist 70 seconds earlier, holding them.

Every click is against the running app and the inserts are real. No cuts,
nothing sped up. GitHub cannot play a repo-hosted MP4 — clicking it in the
file browser gives a size error — so link it from the README by its
[raw URL](https://raw.githubusercontent.com/osmanahmadxai/SYNCLE/main/docs/assets/media/syncle-demo.mp4),
which downloads, or host it on syncle.dev where a `<video>` element can play
it inline.

---

## Stills

### `01-bridge-live-cdc.png` — a live CDC bridge

The hero. Running, 100% success, and the rows that crossed it. **In the README.**

<img src="screenshots/01-bridge-live-cdc.png" width="100%" alt="A live CDC bridge with 2,580 delivered and the rows that crossed it">

### `02-bridge-feed.png` — the same deliveries as a stream

Newest first, one line per row. An alternate hero, and good for the docs.

<img src="screenshots/02-bridge-feed.png" width="100%" alt="The delivery feed, newest first">

### `03-bridge-backfill.png` — a completed replay

5,690 rows, zero failures, per-row timings. **In the README**, next to the
delivery guarantees.

<img src="screenshots/03-bridge-backfill.png" width="100%" alt="A completed replay job with 5,690 rows and no failures">

### `04-workspace-map.png` — the whole product in one image

One source fanning out to four bridges and four destinations. The best single
image for the website.

<img src="screenshots/04-workspace-map.png" width="100%" alt="The workspace map: one Postgres source feeding four bridges into MySQL, MongoDB and Redis">

### `05-bridge-builder.png` — building a bridge

Column selection, a live preview of the source rows, trigger configuration, the
inferred schema and a sample payload. For the website's "build it visually"
section and `docs/bridges`.

<img src="screenshots/05-bridge-builder.png" width="100%" alt="The bridge builder: column checkboxes, row preview, polling configuration and sample payload">

### `06-workbench-data.png` — browsing a table

5,060 rows with the schema tree beside them. **In the README**, in the workbench
section.

<img src="screenshots/06-workbench-data.png" width="100%" alt="The workbench browsing a customers table with the schema tree">

### `07-workbench-structure.png` — columns, keys and indexes

For `docs/workbench`.

<img src="screenshots/07-workbench-structure.png" width="100%" alt="The structure view: column types, defaults, primary key and indexes">

### `08-workbench-query.png` — the SQL editor

A real result set in 11 ms. For the website's workbench section.

<img src="screenshots/08-workbench-query.png" width="100%" alt="The query editor running a grouped aggregate over the customers table">

### `09-workbench-diagram.png` — the ER diagram

Foreign keys drawn between the four tables. **In the README**, and good for the
website.

<img src="screenshots/09-workbench-diagram.png" width="100%" alt="The interactive ER diagram with foreign keys drawn">

---

## Re-shooting after a UI change

The capture is scripted — a compose file for the four databases and a separate
Syncle instance, a seed SQL file, and Playwright scripts that drive the real UI
and wait on real text before each frame, so a slow render cannot produce an
empty screenshot. They live outside this repo today; say the word and they can
land under `scripts/demo/` so re-shooting is one command.
