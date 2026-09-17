# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Redis bridges got a great deal faster, in both directions — and a live bridge
can no longer lose a row to a failed delivery.

### Fixed

- **A failed delivery on a live bridge could lose rows for good.** Three
  separate ways, all closed. The rule now holds everywhere: a row that has been
  read is in the destination, in the bridge's dead-letter queue, or still ahead
  of the cursor — never in none of them.
  - With `onError: continue` — what the builder always sent for a watch or CDC
    bridge — a failed batch was recorded and stepped over: the cursor was saved
    and the source acknowledged past it. On a change stream that is permanent.
    The only copy left was the delivery's captured payload, which is cut at
    16 KB and which the retry path refuses once cut.
  - **PostgreSQL CDC confirmed positions it had not delivered.** Every `BEGIN`
    and `COMMIT` was acknowledged to the server the moment it arrived, on the
    reasoning that everything before it had been processed. Since changes
    became batched in 1.3.0 that is not true: the rows ahead of a `COMMIT` are
    normally still in memory when it arrives, so the replication slot was moved
    past its own transaction's unwritten rows. A delivery that then failed, or a
    crash, had nothing left to re-read. Skipped positions now travel with the
    batch and are confirmed only once it has landed. The same applied to rows
    dropped by a bridge's source filters.
  - With `onError: abort`, the bridge stopped at the failed batch — but a batch
    already queued behind it could still be delivered in the instant before the
    stream shut down, and its checkpoint carried the cursor past the failure.
- **"Use TLS" meant four different things, and none of them was "verified".**
  MySQL and the PostgreSQL change stream encrypted but never checked the
  certificate (`rejectUnauthorized: false`, hard-coded — the change stream
  ignored even the `sslVerify` option the ordinary connection honoured). MongoDB
  ignored the switch entirely with host and port fields and connected in
  **plaintext**. And the MySQL binlog stream — the connection every change
  travels over — was never given TLS options at all, so with TLS on, the
  workbench was encrypted and the replication stream was not. Only Redis
  verified. All of it now goes through one place, and is tested against real
  TLS-only servers on all four engines.
- **SSH tunnels accepted any host key**, so the hop a tunnel exists to protect
  could be impersonated by whoever answered on that address.
- Testing an *edit* of a saved connection always failed unless every secret was
  retyped: the form only holds them redacted, and the test dialled with the
  literal `********`.
- A refused Redis connection reported only "Connection is closed"; it now gives
  the reason (a rejected certificate, a wrong host name).
- **Auto-created tables got the wrong column types, and values changed on the
  way across.** Both halves of cross-engine translation were rebuilt, and are
  now checked against real PostgreSQL, MySQL, MongoDB and SQLite — by replay and
  by CDC, under three different server time zones.
  - Types were matched by substring. `interval` became `INTEGER` (it starts with
    "int"); a MongoDB `_id` became `JSONB` (objectId contains "object"), which
    then rejected the id it was given; `timestamp with time zone` lost its zone;
    `numeric(38,10)` became a float; `bytea` and `blob` became text; MySQL
    `tinyint(1)` became an integer and `int unsigned` a signed `INTEGER` it can
    overflow. Types are now looked up by name, per engine. Between two instances
    of the same engine the source's type is reused verbatim, so a same-engine
    copy narrows nothing.
  - PostgreSQL's catalog label was used where the real type was needed:
    `numeric`, `character varying` and `ARRAY` for columns that are
    `numeric(38,10)`, `character varying(255)` and `integer[]`. Precision,
    length and array element types are now read too.
  - **Timestamps depended on the server's time zone.** `pg` parses a
    `timestamp without time zone` in the process's zone, so on a server at
    UTC+4:30 `05:06:07` became 00:36Z, and any writer that formats dates as UTC
    stored a different time than the source holds. Dates and timestamps are now
    read as the text PostgreSQL sends. That also keeps **microseconds**, which a
    JavaScript date silently rounded off every `now()`-stamped column. MySQL
    writes an instant as UTC instead of in the process's zone. The polling
    cursor's lookback window had the same fault: on a server at UTC−8 a 3-second
    window pointed 8 hours into the future, and skipped rows.
  - An empty JSON array written to PostgreSQL arrived as `{}`, an empty *object*,
    with no error: a JavaScript array bound as a parameter is sent as a
    PostgreSQL array literal. Non-empty arrays failed outright, and the JSON
    string `"123"` arrived as the number 123. Batches of 250+ rows took a
    different write path and did not have the bug — so the same data synced
    differently in a backfill than it did live. JSON now reaches PostgreSQL
    correctly on both paths, whatever it holds.
  - MySQL CDC rounded every `DECIMAL` to a double — the binlog reader builds the
    exact digits and then calls `parseFloat` — while the same column read by a
    replay stayed exact. Patched (`patches/`), reported values are now identical.
    MySQL CDC also delivered a JSON column as text where a replay delivered the
    parsed value.
  - SQLite returned 64-bit integers as JavaScript numbers: 9223372036854775807
    read back as 9223372036854776000, and a bridge then wrote that. A column
    with no declared type was treated as a BLOB.
  - MongoDB `Decimal128`, `Long`, binaries, UUIDs and *nested* `ObjectId`s
    reached SQL targets as the driver's internal objects. A field's type was
    taken from the first document only, so a field that started `null` became a
    text column.
- **After the first replay in a process, every later replay bridge created its
  destination table with the FIRST bridge's columns.** A replay resolves its
  bridge from the job's config snapshot, which came back with an empty id — and
  the sink caches source columns by bridge id, so every replay shared one slot.
  Deliveries then failed with `column … does not exist`.
- A delete reaching a target with no key columns (an `insert`-mode, append-only
  target) failed the whole delivery: there was nothing to delete by, and the
  empty `WHERE` was rejected by every engine. Such a target now simply does not
  apply deletes; keyed targets on the same bridge are unaffected.
- Documentation no longer says a CDC bridge always delivers one row per
  delivery. That stopped being true for database destinations in 1.3.0.

### Added

- A **dead-letter queue** for watch and CDC bridges. Under `onError: continue`
  the rows that could not be delivered are written, complete, to the queue
  *before* the cursor moves, then retried when you ask — from the job view, or
  `POST /api/bridges/:id/dead-letters/retry`.
  - One bad row no longer takes its batch with it. A database batch is one
    transaction, so a single row the destination refuses fails all of them; the
    batch is now split until each failure is pinned to a row, the healthy rows
    are delivered, and only the rows at fault are queued. Finding one among a
    hundred thousand takes a few dozen attempts.
  - Retrying is safe while the bridge is still running, because a retry does
    not replay the recording. For a database destination it re-reads the row
    from the source and writes what is there now — the current row, a delete if
    it is gone, nothing if it has left the bridge's filters — so an old payload
    can never overwrite a newer version delivered in the meantime.
  - `continue` is for bad rows, not a broken destination. A bridge still stops,
    without moving its cursor, when a failure is not confined to a few rows,
    when several batches in a row deliver nothing
    (`SYNCLE_MAX_CONSECUTIVE_FAILURES`, 5), or when the queue is full
    (`SYNCLE_DEAD_LETTER_MAX_ROWS`, 10,000).
- The builder offers **On failure** for watch and CDC bridges, where it was
  previously hidden and fixed to `continue`.
- **TLS modes**: off, encrypt only, verify the authority, verify the authority
  *and* the host name — PostgreSQL's `sslmode` names, meaning the same on every
  engine and applied to every connection a bridge opens, the CDC streams
  included. With a CA certificate for private CAs, an expected server name, and
  a client certificate and key for mutual TLS (the key encrypted at rest).
  Through an SSH tunnel the certificate is checked against the database's host
  name, not the tunnel's `127.0.0.1`. Both MySQL clients lacked a host-name
  check: the adapter now verifies after the handshake (mysql2 skips the check
  for IP hosts), and the binlog client is patched to verify inside it.
- **SSH host key pinning.** Give the jump host's `SHA256:…` fingerprint and any
  other key is refused; leave it empty and the key from the first connection is
  recorded and enforced (the Test button shows it first). A changed key refuses
  to connect and says why.
- **Type warnings.** Whenever a target column cannot hold everything the source
  column can — a time zone MySQL has nowhere to put, more precision than
  `DECIMAL(65,30)`, a key that had to be bounded to `VARCHAR(255)`, an enum
  carried as text — the column is named. `POST /api/bridges/:id/preview` now
  reports whether each target table exists and, when a run would create it, the
  exact columns (`plannedColumns`) and those warnings — before anything runs.

### Changed

- **`onError` defaults to `abort`** for a bridge created through the API without
  one. Bridges that already exist keep the value they were saved with, and the
  web app's builder still pre-selects `continue` — which, with the queue, no
  longer loses anything.
- Connections saved under the old TLS switch keep exactly what it did on their
  engine, shown as the matching mode — with one exception: a **MongoDB**
  connection with the switch on now really uses TLS (it was plaintext), and
  fails if the server does not offer it.
- The workbench shows PostgreSQL dates and timestamps as PostgreSQL writes them
  (`2026-03-04 05:06:07.891234+00`) rather than as a JavaScript date rendered in
  UTC, which was off by the server's offset for columns without a time zone.
- Auto-created MySQL text columns are `LONGTEXT`, not `TEXT`: a PostgreSQL
  `text` value is not limited to 64 KB. Existing tables are never altered.
- A live bridge stopped by a failure now says what failed, not only that
  something did, and reuses the failed delivery when it is started again
  instead of leaving a permanently red cell beside a fresh green one.

- **Writing into Redis** no longer costs a round trip per row. The adapter
  issued one `SET` per row with no pipelining, so a batch of a thousand rows
  was a thousand round trips. A pipeline sends the batch as one write and reads
  one reply. Measured against a million rows, a Redis destination now takes
  around 90,000 to 110,000 rows/sec depending on the source.
- **Reading from Redis** is roughly twenty times faster: about 2,000 rows/sec
  before, 21,000 to 50,000 now.

  A keyspace notification carries only the key, so every change needed a round
  trip to learn its type and another to read its value — and those ran one
  event at a time, each waiting for the previous event's delivery before its own
  read could begin. Events now queue and drain in batches, with one pipeline
  covering a whole batch's reads. Arrival order is unchanged, which is the part
  that matters: a delete still cannot overtake the write before it and
  resurrect a key.

  This does not make Redis a durable source. Keyspace notifications remain
  fire-and-forget with no backlog; the change only shrinks the window in which
  events pile up unread. A watch bridge is still the right choice where losing
  events is unacceptable.

### Added

- The benchmark suite covers every engine as a source and every engine as a
  destination — twenty pairs, a million rows each — rather than the three
  engines it started with. Results at
  [syncle.dev/benchmarks](https://syncle.dev/benchmarks), rendered as a
  source-by-destination grid.
- An integration suite covering all twenty pairs against real engines, checking
  the values that arrive rather than the row count, since a mapping that
  transposed two columns would pass a count check.

## [1.3.0] - 2026-09-08

Syncing got about four times faster, and there are now real numbers for it.

### Added

- **Benchmarks**, measured against real databases with a million rows per
  scenario and published at [syncle.dev/benchmarks](https://syncle.dev/benchmarks).
  The runner lives in the repository and writes `benchmarks/results.json`; the
  page renders that file and nothing else, so every figure shown can be
  reproduced with `pnpm benchmark`. The recorded run states the machine, the
  engine versions, the configuration used, and what else was running.
- An **optional durable spool** between the change reader and the destination
  (`SYNCLE_CDC_SPOOL=on`), backed by a Redis stream. With it on, the source is
  acknowledged as soon as changes are spooled, so a slow or unreachable
  destination no longer holds the source's log open — the failure mode where a
  Postgres replication slot stops advancing and WAL fills the source's disk.
  Off by default: while a change sits in the spool, Redis is the only copy of
  it, so it is safe only where Redis has persistence.
- **Italian localization** for the web app. Thanks to @albanobattistella.
- A new language now needs only its message file. Locales are derived from
  `src/messages/`, so adding `<code>.json` is the whole job — no allowlist to
  update, and the toggle labels itself.
- A **Docs** link in the header.
- An integration suite that runs against real PostgreSQL, MySQL, MongoDB and
  Redis, including end-to-end syncing through the real application.

### Changed

- **Change data capture is roughly four times faster.** A million rows
  PostgreSQL to PostgreSQL takes about 16 seconds where it took 52. Changes are
  grouped into batches rather than delivered a row at a time, so one delivery,
  one delivery record, one cursor write and one source acknowledgement now
  cover a whole batch. PostgreSQL bulk writes go as a single json parameter
  rather than one parameter per value, which removes the 65,535 bound-parameter
  ceiling; and reading now overlaps with writing instead of waiting for it.
- Database destinations receive rows in one statement per batch instead of one
  statement per row. Deliveries in the timeline are therefore fewer and larger:
  the same rows, recorded at coarser granularity.
- Batch size and behaviour are tunable — `SYNCLE_CDC_BATCH_SIZE` (100,000),
  `SYNCLE_CDC_BATCH_BYTES` (64 MB), `SYNCLE_CDC_LINGER_MS` (50). The row
  default is the measured peak across five runs of a million rows on both
  PostgreSQL and MySQL; the byte ceiling is what actually bounds memory, so
  wide rows flush early on their own.
- HTTP destinations are unchanged: they keep honouring the bridge's own
  `batchSize`, where the batch size is the payload the receiver sees.
- Documentation no longer claims MariaDB support. Connections, replay and watch
  bridges work through `mysql2`, but CDC reads the binlog with a client that
  targets MySQL and has not been verified against MariaDB. The 1.0.0 notes
  below listed it; that was the claim being corrected, not a regression.
- `binlog_transaction_compression` is documented as unsupported. MySQL 8.0.20+
  can wrap row events in a compressed payload event that the binlog reader
  cannot decode, so those rows are not seen. Leave it off on a source you
  stream from.

### Fixed

- **MongoDB destinations were never indexed on the column they upsert on.** A
  collection indexes `_id` and nothing else, so every upsert was a collection
  scan — which degrades as the collection grows and made a large sync
  effectively unable to finish. The index is now created, and MongoDB
  destinations are several times faster as a result. An index appears on
  existing targets the first time a bridge writes to them.
- **MySQL CDC refuses to resume against a different server** than the one that
  issued its stored binlog position. File and position mean something only on
  the issuing server, so after a failover the old cursor pointed somewhere
  unrelated and the stream read it anyway. Cursors now carry the server's
  `@@server_uuid`, and the transaction's GTID alongside it.
- **A MySQL bridge no longer reports itself running before the binlog reader is
  positioned.** On a fresh bridge that raced the first writes, and rows written
  immediately after starting were lost.
- Batched deletes on SQLite no longer fail on large batches. Staying under the
  bound-parameter limit is not sufficient there — SQLite also caps expression
  tree depth, which a long chain of `OR` clauses exceeds.

## [1.2.0] - 2026-08-21

Setup no longer sends you to the container logs.

### Changed

- `syncle up` reads the first-run setup token off the server and opens the GUI
  with it already accepted, so creating the admin account is a username and a
  password rather than a hunt through `syncle logs api`. The token is mirrored
  to a `0600` file in the API's data directory, so reading it still requires
  container access on that host — which is exactly what the token attests.
  Anyone reaching the instance over the network still faces an empty token
  field. The token travels in the URL *fragment*, which browsers never send
  upstream, is stripped from the address bar on read, is deleted the moment
  setup succeeds, and is cleared at boot if an account already exists.

### Fixed

- `syncle up` works offline. A failed image pull aborted the whole start, so a
  machine with the images already cached could not run Syncle at all. The pull
  is now best-effort, and a genuinely missing image fails at `up` with a
  clearer message.
- The installer resolves the right image tag. It used the release tag verbatim
  (`v1.2.0`) where images publish without the prefix (`1.2.0`), so a fresh
  install died with `failed to resolve reference … not found`.

## [1.1.0] - 2026-08-21

One command to install, SSH tunnels, and hooks renamed to bridges.

### Added

- One-command Docker install (`install.sh`) and the `syncle` launcher CLI —
  `up`, `down`, `logs`, `update`, `uninstall`. The app image is pulled prebuilt
  from GHCR, so nothing is compiled locally and the repository is never cloned.
- **SSH tunnels**, for databases that only listen on a private network and have
  to be reached through a bastion host.
- Chinese (zh) localization for the web app, via `next-intl`. Thanks to
  @250shiwo.
- Delivered rows can be read as a table with columns derived from the payloads,
  or as a newest-first feed. The original cell grid remains as **Map**, where
  queued sequences can be skipped.
- A **setup token** guarding first-run account creation, so an exposed instance
  cannot be claimed by whoever reaches it first.
- Rate limiting on login and setup attempts, and an SSRF guard on outbound HTTP
  destinations.

### Changed

- **Breaking.** A *hook* is now a **bridge** and a *run* is now a **job**,
  throughout. `/api/hooks` is now `/api/bridges`; anything scripting against
  the API needs updating. The web UI is unaffected and the database migrates
  itself on upgrade.
- The bridge builder was split into sections backed by a single draft reducer.

### Fixed

- **CDC** — closed data-loss and ordering gaps in event-based bridges.
- **Watch triggers** — ordering, a livelock, lookback handling, filters and
  cancellation; the lookback dedupe now stays stable across truncated pages.
- **Delivery retries and database sinks** — integrity fixes so a retry or a
  write cannot double-apply or drop rows.
- **Lifecycle and resume** — one lifecycle owner, dialect hooks, abort signals
  actually honoured, and exact keyset resume.
- Master key and signing key hygiene.

## [1.0.0] - 2026-07-23

First stable release: visual hooks between any supported engines (PostgreSQL,
MySQL/MariaDB, SQLite, MongoDB, Redis) and HTTP endpoints, fired by one-shot
replay, cursor polling, or change-data-capture — with idempotent multi-target
delivery, a live timeline, and the database workbench.

### Added

- Database-to-database sync: rows move across engines directly, with HTTP
  endpoints as an extra destination rather than the only one.
- Workspaces, and a live workspace map.
- Event-based (CDC) delivery for **MySQL** (binlog), **MongoDB** (change
  streams), and **Redis** (keyspace notifications), alongside the existing
  PostgreSQL logical-replication support. Each engine sits behind a shared
  `CdcProvider` interface.
- A login system and a settings section.
- The `{{$op}}` payload token, exposing the change operation
  (`insert` / `update` / `delete`) for CDC and watch hooks.
- README visuals: animated banner, badges, diagrams, and a how-to guide.

### Changed

- Renamed the project to **Syncle** (formerly Data Bridge).
- The internal metadata store now runs on **PostgreSQL** instead of SQLite.
- The live delivery monitor fetches one final time when a run finishes, so the
  last cells settle correctly; added a LIVE indicator and auto-follow paging.

### Fixed

- Crash, data-loss, and injection paths across the API layer, the sync engine,
  and core adapters; multi-target writes are atomic and backup memory is
  bounded.
- Stale-state bugs in the studio, which now updates instantly.
- Delivery timeline now uses the run's snapshot `batchSize`, keeping cells
  aligned even after a hook is edited mid-run.
