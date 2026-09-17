# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Redis bridges got a great deal faster, in both directions — and a live bridge
can no longer lose a row to a failed delivery.

### Security

- **Next.js 15.5.25** in the app and in the documentation site. 15.5.18 — what
  the app shipped — is affected by two critical advisories (unauthenticated
  remote code execution, one in the image optimizer) and eight more rated high
  or moderate. If you run Syncle from an older image, update.
- Patched releases of libraries pulled in by others, pinned with
  `pnpm.overrides` inside their current major versions: `multer` 2.4 (six
  denial-of-service advisories in multipart parsing), `qs` 6.16, `body-parser`
  1.20.8, `nanoid` 3.3.18, `postcss` 8.5.23, `postcss-selector-parser` 6.1.3 and
  `sharp` 0.35.4 (libvips / libheif). `mysql2` 3.24 (unbounded inflate of a
  compressed protocol packet).
- `pnpm audit --prod` is down from 49 findings (2 critical, 19 high) to 3
  moderate ones, none of them reachable: `@nestjs/core`'s is in its
  Server-Sent-Events stream and `file-type`'s in upload validation, and Syncle
  has neither an SSE route nor a file upload. Both need a major-version upgrade
  of NestJS, which is a change of its own.

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
- **PostgreSQL CDC lost rows without a single error**, in ways that only show
  up under real traffic. Each was reproduced on the previous release before it
  was fixed, and each now has a test against a real server.
  - **Bulk loads.** `COPY` writes a couple of hundred rows per WAL record, and
    every one of them is reported at that record's position. The stream used
    the position both as the cursor and to drop "already processed" changes
    after a reconnect, so once a batch boundary fell inside a record, the rest
    of that record looked like duplicates. Measured: `COPY` of 3,000 rows into
    a tracked table, 1,412 delivered.
  - **Overlapping transactions.** PostgreSQL streams transactions in *commit*
    order, but tags each change with where it was *written*. A transaction that
    started first and committed last therefore arrives carrying lower positions
    than changes already seen, and was discarded as old. Measured with two
    sessions: rows 1, 2, 3 written; 2 and 3 delivered.
  - **A restart between two transactions that committed back to back** lost the
    second one. The replication client confirms `position + 1`, but a commit's
    end position is already one past its last byte — so the extra byte reached
    into the next commit record, and PostgreSQL considered that transaction
    confirmed as well and never sent it again.

  A change's position is now its transaction's commit position, then its own,
  then its ordinal among changes sharing a record: ordered the way PostgreSQL
  streams, unique per row, and the same if the server sends the transaction
  again — so a stop in the middle of a large transaction resumes in the middle.
  Only the end of a transaction is ever confirmed to the server, at exactly its
  end. Cursors saved by earlier versions are still understood; the first start
  after upgrading may deliver the last transaction once more.
- **An `UPDATE` that did not touch a large column wiped it at the destination.**
  PostgreSQL stores large values out of line (TOAST) and leaves them out of an
  update that did not change them; "not sent" was read as `NULL`. The column is
  now left out of the write, so the destination keeps its copy — through the
  dead-letter queue and the spool as well. Where the value itself is needed (a
  source filter on that column, an HTTP payload, a Redis destination, a row
  whose key changed) it is read back from the source.
- **An `UPDATE` of a primary key left the old row at the destination for ever**:
  the new row was upserted under its new key and nothing removed the old one.
  It is now a delete of the old key followed by the new row.
- **A partitioned PostgreSQL table streamed nothing at all.** Its changes are
  logged against the partitions, arrived under the partitions' names, and were
  discarded as another table's. Publications are now created with
  `publish_via_partition_root` (PostgreSQL 13+; on 12 the bridge is refused
  with an explanation instead of sitting silent).
- **Starting a CDC bridge could break the source application.** Publishing
  updates or deletes for a table with no primary key and no replica identity
  makes every `UPDATE` and `DELETE` on it fail, in the owner's database. Syncle
  now checks before it creates anything and refuses, saying what to do
  (capture inserts only, add a key, or `REPLICA IDENTITY FULL`). A publication
  also now publishes only the operations the bridge captures, and is brought up
  to date when they are edited — it used to keep whatever it was created with.
- A delete that carries no value for the target's key column reported
  "deleted 0" and succeeded, leaving the row behind. That happens when a target
  is keyed on a column PostgreSQL does not send with a delete (it sends only
  the replica identity). The bridge is now refused at start, and a delete
  without its key is a failed delivery rather than a green tick.
- A PostgreSQL CDC bridge on a table nobody was writing to was disconnected by
  the server every `wal_sender_timeout` (60 s by default) and reconnected: with
  nothing confirmed yet it had nothing to answer keepalives with. It now
  answers with the slot's own position.
- **A CDC bridge could fill its source's disk.** A PostgreSQL replication slot
  makes the server keep every byte of WAL since the slot's position for as long
  as the slot exists, read or not — and there were four ways to leave one
  behind, none of which said anything:
  - A paused or failed bridge keeps its slot (so it can resume), and nothing
    measured what that was costing. It is now measured every minute and shown
    on the bridge once it passes `SYNCLE_SLOT_WARN_BYTES` (1 GiB).
  - **Editing a CDC bridge into a watch or replay bridge, or pointing it at
    another connection or database, never dropped its slot.** Nothing pointed
    at the old source any more, so nothing ever would. It is dropped now.
  - A drop that failed when a bridge was deleted (the source was unreachable at
    that moment) was logged and forgotten — along with the only record of the
    slot's name. It is now written down and retried every minute, and the
    connection it has to go through cannot be deleted until it is gone.
  - A server with no `max_slot_wal_keep_size` lets a slot pin WAL without
    limit. The readiness check now says so.
- **A bridge whose place in the change log was gone carried on from "now"
  without a word.** If the replication slot had been dropped or invalidated, a
  start simply made a new one at the current position; MongoDB did the same
  when the oplog had rolled past the resume token, with a line in the log.
  Either way the destination had a hole in it that nothing showed. Such a
  bridge now stops — or refuses to start, or to resume at boot — and says why.
  Starting it again asks you to confirm **Continue from now**
  (`{ "fromNow": true }`), the timeline records where the gap is, and a replay
  fills it. MySQL is covered too: a purged binlog file, or a connection that
  now reaches a different server, is detected before the stream is opened
  instead of failing in a loop.
- **CDC ignored a connection's SSH tunnel.** Change streams open their own
  connections — a replication connection, a binlog client, a change stream, a
  subscriber — and dialled the database host as written. Behind a bastion that
  host is unreachable, so the workbench and replays worked on a tunnelled
  connection and CDC on the very same connection never connected; Redis and
  MongoDB failed already at the readiness check. A stream now gets a tunnel of
  its own for as long as it runs, the bastion's host key is pinned as usual, and
  a tunnel that drops is replaced and the stream resumed from its checkpoint.
  Tested against a real SSH server, with database host names that only resolve
  on the far side of it.
- Through a tunnel, MongoDB connections (workbench and CDC alike) went on to
  discover the replica set and dial its members by their internal names, which
  cannot be reached from this side — the first query timed out on a connection
  that had "tested" fine. A tunnelled connection now talks only to the address
  it was given.
- **With a connection string, the database you chose was ignored** on PostgreSQL
  and MySQL: both drivers let the string's database win over one given beside
  it. The workbench showed the string's database under another one's name, and a
  bridge configured to read `orders_eu` read whatever the string said. The
  chosen database now goes into the string. (The PostgreSQL change stream
  already did this, without encoding the name; it shares the helper now, and
  honours a TLS setting chosen beside a connection string, which it ignored.)
- **The login lockout could be walked around.** Attempts were counted per
  address and user name, and the address is `req.ip` — with `trust proxy` on,
  the left-most `X-Forwarded-For` entry, which the bundled web proxy relays
  exactly as the browser sent it. A guesser who put a new made-up address in
  that header on every attempt got a fresh counter every time and was never
  locked out. Failures are now also counted per user name, from anywhere: ten,
  then a pause that doubles up to a minute — about one guess a minute. The
  lockout table also forgot nothing until a key succeeded, which a made-up user
  name never does; it is bounded now.
- **The session timeout was not an inactivity timeout**, though the setting, its
  hint and the docs all said so: the cookie's issue time was set at sign-in and
  never again, so a session ended that long after signing in however busy it
  had been. With it set to 15 minutes an operator was thrown out every quarter
  of an hour, mid-edit. An active session is now renewed.
- A malformed session cookie (`db_session=%%%`) made every route answer 500
  instead of 401: `decodeURIComponent` throws on it.
- **Half the interface ignored the language setting.** The data sources surface
  (schema tree, data grid, row editor, query editor, structure view, create
  table / database), the job view, the whole delivery timeline, the Settings
  dialog and the confirmation dialog were hard-coded English — about 300 strings
  — so in Italian or Chinese the app switched language mid-screen. All of it is
  translated now, with counts as proper plurals ("1 row" / "2 rows") instead of
  "row(s)". A test holds the three locales to the same keys and placeholders and
  checks that every key the code asks for exists: a missing one is not a build
  error in next-intl, it is a raw `bridges.runJob` on somebody's screen.
- The query editor's own starter text for MongoDB could not be run: it opens
  with a `//` comment and the query was handed to `JSON.parse` as it was.
  Whole-line comments are skipped, as the Redis dialect always did with `#`.
- **Most of the Settings dialog did nothing.** The default poll interval, rows
  per poll and CDC operations, the query row cap and job concurrency were
  stored, shown and reported by the API, and read by nothing — the docs carried
  a note admitting it. New bridges now start from the saved defaults; the row
  cap applies to every connection without its own, including ones already open;
  and the replay worker follows the concurrency setting the moment it is saved.
- **Opening a watch bridge in the builder and pressing Save reset parts of it.**
  The builder has no control for rows-per-poll, the snapshot window or the
  timestamp lookback, and wrote the constants 500 / 50,000 / 3,000 on every
  save — undoing whatever had been set through the API. They are now carried
  through an edit untouched.
- `mssql` was listed as an engine with no driver behind it, on the understanding
  that the API would refuse it; it did not, so such a connection could be saved
  and then answered 501 to everything. It is gone from the list until an adapter
  exists, a test holds the engine list and the drivers together, and the API
  checks the driver registry before it saves a connection.
- **The browser's Back button left Syncle** instead of returning to the bridge
  you were on. The app wrote its place into the URL with `replaceState`, so the
  whole session was a single history entry, and nothing listened for
  `popstate`, so Forward back into the app changed the address bar and nothing
  else. Opening a bridge, the data sources or the builder is now a history
  entry; Back and Forward move between them; a reload still lands where it was.
- **On a Docker install, almost no setting could be changed.** The compose file
  listed the API's environment by hand and passed two variables through, so the
  CDC spool, the batch sizes, the dead-letter limits and everything since were
  unreachable for anyone who installed Syncle the recommended way — the docs
  said as much. Every setting the API reads is now passed through from
  `~/.syncle/.env` (add a line, then `syncle up`), and a test fails if one is
  added to the API and not to the compose file. The API also reads an empty or
  non-numeric value as "use the default": `Number('')` is 0, so a variable
  passed through unset would otherwise have meant a batch size, a query cap and
  a pool timeout of zero.
- **A Redis CDC bridge captured Syncle's own writes.** A keyspace subscription
  hears every write to the database, and when the Redis being bridged from is
  the one Syncle itself runs on — a single shared Redis, which is also what the
  test suite uses — that included Syncle's keys. With `SYNCLE_CDC_SPOOL=on` it
  was a closed loop: each captured change was appended to the bridge's spool
  stream, the `XADD` fired a keyspace event, and the bridge captured *that*.
  Measured: 120,000 events in twenty seconds, all of them the spool's, while the
  user's rows never arrived — every Redis source delivered nothing with the
  spool on. Without the spool, a bridge with no key filter delivered the job
  queues' bookkeeping keys as if they were data. Syncle's own keys are now
  never treated as changes.
- A Redis CDC bridge writing into the same Redis database it listens to fed on
  its own output for ever. It is refused at start (and not resumed at boot),
  with the fix spelled out: another database number is enough.
- With the spool on, deleting a bridge left its Redis stream — and whatever
  undelivered rows were in it — behind for good: the method that clears it was
  never called. It is cleared on delete, and when a bridge leaves its source.
- A CDC bridge could be started on a PostgreSQL server with no replication slot
  or WAL sender to spare, and failed inside the stream. The readiness check now
  counts both (a bridge that already owns a slot is not counted against
  itself).
- A delete reaching a target with no key columns (an `insert`-mode, append-only
  target) failed the whole delivery: there was nothing to delete by, and the
  empty `WHERE` was rejected by every engine. Such a target now simply does not
  apply deletes; keyed targets on the same bridge are unaffected.
- Documentation no longer says a CDC bridge always delivers one row per
  delivery. That stopped being true for database destinations in 1.3.0.
- **A replay from Redis copied the first 200 keys and reported success.** Redis
  has no order to page by, and the replay paged it like a table anyway: "keys
  greater than the last one". The Redis adapter reads any filter on `key` as a
  glob, so page two asked for the keys that *contain* the last key of page one,
  got that one key back, and the job finished — `completed`, no error, one page
  deep into a database of any size. (With a key filter of the bridge's own, page
  one was read again for ever instead.) A Redis source is now read by following
  its `SCAN` cursor to the end, which is also what makes the read complete:
  every key that exists for the length of the read is returned. A stopped replay
  resumes from the cursor of the page it was in.
  - The same read cut every list and sorted set to its first 25 entries — it
    went through the preview the data grid uses. A replay reads values whole.
  - Syncle's own keys (its job queues, a bridge's spool) are left out of a
    replay when the Redis being read is the one Syncle runs on, as they already
    were from a change stream.
- **"Retry failed" on a replay that had stopped at a failure marked it
  completed — without ever sending the rows after the failure.** A replay stops
  at the first failed delivery by default (`onError: abort`). Fix the cause,
  press *Retry failed*: the failed delivery was re-sent, succeeded, and the job
  turned `completed`. The rows the run had never reached were not read, not
  sent, and not mentioned. A replay now records when it has read its source to
  the end; one that has not carries on from where it stopped once its failures
  are cleared (with the bridge as it is configured *now* — the fix is often
  there), and stops again at the next failure rather than go past it.
- **On MongoDB, nothing that looked a document up by its `_id` found it.** A row
  shows an ObjectId as its 24 hex characters, and that text is what came back in
  every filter on `_id`. MongoDB does not compare an ObjectId with a string, so
  each of these matched nothing, without an error:
  - a **replay ended — `completed` — after its first page** (200 documents) of
    any collection keyed by ObjectId, which is nearly every collection;
  - a bridge over **rows picked in the builder** delivered none of them;
  - a **dead-letter retry** could not find the document it was retrying, took it
    for deleted at the source, and resolved the entry *without ever delivering
    it*.

  A filter on `_id` now looks for the ObjectId the text shows (and for the text,
  which a collection may legitimately use as a key). A read of a whole
  collection pages by the typed `_id` itself, and still reaches the end of a
  collection whose `_id`s are of several kinds.
- **Two conditions on one MongoDB field left only the second.** `age >= 18` and
  `age < 65` were written into one object under the same key; the bridge ran
  with `age < 65` alone. Conditions are ANDed.
- **MongoDB change stream: an update of a document deleted a moment later was
  delivered as an update to nothing.** The document is looked up after the
  event; when it was already gone, the row that went out held the `_id` and no
  other field — NULLs written over a good row, or a row the destination refused,
  which stopped the bridge. Such an update is now passed over; the delete is
  next in the stream.
- **A Redis key filter meant one thing to a replay and another to a change
  stream.** The replay read any filter on `key` as "contains"; the stream read
  it as an exact glob. `equals` is now the glob as written (`user:*`), and
  `contains` / `starts with` / `ends with` are what they say — for both. (The
  data grid's `equals` on a key therefore no longer behaves like `contains`.)
  The stream's matcher also understands `[a-c]`, `[^x]` and `\` escapes, as
  Redis's own `MATCH` does.
- **Editing a bridge in the builder deleted parts of it.** The builder could
  write exactly one source filter — the row selection — and rebuilt the rest of
  the configuration from what it has controls for. Saving a bridge that had been
  given other filters, a payload `template` or a `rename` map through the API
  silently removed them: a bridge filtered to `country = 'IT'` started sending
  every row of the table after an unrelated edit. Filters are now edited in the
  builder; conditions it has no row for (an `in` list, for instance), the
  template and the rename map are carried through an edit untouched.
- The snapshot watch strategy's source file held a raw NUL byte inside a string
  literal, which made `grep`, `git diff` and some editors treat the whole file
  as binary. It is written as `\0` now; the row hashes it produces are
  byte-for-byte the same, so existing snapshot bridges do not re-send anything.
- **A column renamed or dropped at the source emptied the copy of it, one row
  at a time.** A bridge maps columns by name. When a mapped column went — and a
  rename, to a catalog, is a drop and an add — every row from then on had no
  value under that name, and the upsert wrote `NULL` over the value the
  destination held. Each delivery was green; the only trace was the data.
  A bridge now keeps the columns it was built for, compares them with the table
  before a run and the moment a row arrives with different columns — on a live
  bridge, in the middle of a replay, before a dead-letter retry — and
  **stops before that write** — the job says which column, the row is neither
  delivered nor skipped, and the destination is as it was. Accepting the change
  cannot be used to wave it through: neither the button nor saving the bridge
  unchanged forgets a column the bridge still uses. The same goes for a column
  an HTTP payload pins or names in its template, a filter, a sort, a transform
  or a watch column. See *Added* for the setting that governs it.
- **A polling bridge on an `updated_at` column lost updates.** The `timestamp`
  strategy re-reads the rows at its cursor's boundary on every poll, and knew
  which of them it had already sent by their primary key alone. When one of
  those rows — the most recently changed rows of the table — was changed
  *again*, the poll that fetched it took it for a duplicate and then moved the
  cursor past it: the update was never delivered, no error, nothing to retry.
  An order marked `paid` and then `shipped` stayed `paid` at the destination.
  With the default 3-second lookback the same happened to any row changed twice
  within the window, and on a table where the same few rows keep changing it was
  most updates. Rows are now remembered by key *and* the timestamp they carried;
  cursors saved by earlier versions are still read, without re-sending anything.
  (`increment` and `snapshot` are insert-only by design, as documented.)

### Added

- **Verify and reconcile.** Is the destination the copy of the source? Every
  delivery can be green and the answer still be no: a row edited by hand at the
  destination, a delete made while the bridge was stopped, a restored backup.
  *Verify* (on a bridge's page; `POST /api/bridges/:id/verify`) reads both ends
  and reports rows that are missing, different, or only in the destination —
  compared by the kind of value each column holds, through the same transforms,
  value conversion and mapping the bridge writes with, with up to 25 examples of
  each and both readings of every column that differs.
  - On a bridge that is delivering, what looks wrong is read again from both
    ends a moment later (`SYNCLE_VERIFY_RECHECK_MS`, default 1500) and only
    what is still wrong counts.
  - *Reconcile* writes what is missing or different, from the source as it is
    then, and checks that the repair was not overtaken by the stream. Rows that
    are only in the destination are removed only with `deleteExtra`, and then as
    the target's delete policy says.
  - For table sources and PostgreSQL, MySQL/MariaDB, SQLite and MongoDB targets
    with key columns; anything else says why it cannot be compared. Runs in the
    background in a queue of its own, one per bridge, cancellable; the last ten
    results are kept.
  - Verified against itself: every cross-engine replay in the type-fidelity and
    engine-matrix test suites is now followed by a verification that must find
    nothing — which is how the polling bug above was found.

- **Scheduled replays.** A replay bridge can run by itself: *When it runs → On
  a schedule* in the builder, `trigger.schedule { cron, timezone, enabled }` in
  the API. Five-field cron with names, lists, ranges and steps; a named time
  zone, so "02:00" is 02:00 there in summer and in winter (one run on the night
  the hour repeats, one — an hour on — on the night it does not exist). The
  builder shows the next runs as the server computes them, with the library
  that fires them.
  - A tick never starts a run beside one that is still going: it is skipped,
    shown on the bridge and sent to alert channels as a warning.
  - A scheduled run starts from the top. (Pressing Run on a bridge whose last
    run stopped half-way resumes that run; "every night" must not.)
  - The scheduler lives in Redis: it survives restarts, fires once between
    several API processes, and is reconciled with the database at every start.
    Deleting or disabling the bridge, or switching the schedule off, removes it.
  - A bridge that is imported or duplicated keeps its line, switched off.
  - Runs record who started them (`startedBy: manual | schedule`), marked in the
    run list. New routes `GET /api/bridges/:id/schedule` and
    `POST /api/bridges/schedule-preview`.

- **Schema drift: a bridge knows when its source table changes.** New delivery
  setting `onSchemaChange`, in the builder as *When the source table changes*:
  - `stop` (default) — a column the bridge uses is gone: stop before writing.
    Anything else (a column added, retyped, or an unused one dropped) is shown
    on the bridge's page with an *Accept* button, and the bridge carries on.
  - `evolve` — the same, and a column added at the source is added to every
    destination table Syncle creates *and* fills without a column mapping:
    typed by the map auto-created tables use, always nullable, on PostgreSQL,
    MySQL/MariaDB and SQLite. Nothing is ever dropped or retyped.
  - `continue` — the old behaviour, for a copy meant to follow the source
    whatever it does.

  New alert event `bridge.schema_drift` (critical on a stop, warning
  otherwise), said once per change rather than once per batch. New routes
  `GET /api/bridges/:id/schema-drift` and `POST …/schema-drift/accept`. Sources
  with no schema to compare (MongoDB, Redis, saved queries) are left alone.
  Existing bridges get their baseline at their next run or save.

- **API keys.** A script or a CI job no longer needs the operator's password:
  create a key in *Settings › Security*, send it as `Authorization: Bearer
  syn_…`. Shown once; only a SHA-256 of it is stored. `read` keys may `GET` and
  nothing else; `full` keys may do what the operator can **except anything about
  credentials** — no key can list, create or revoke keys, change the password or
  end sessions, so a leaked key cannot mint more keys or lock you out. Optional
  expiry; a revoked key stays listed, crossed out, with when it was last used.
- **Duplicate, export and import bridges.** *Duplicate* copies a bridge in place
  (credential included — it never leaves the instance). *Export* downloads a
  bridge, or a workspace's, as a JSON document with **no secret in it**: an HTTP
  credential leaves empty — never as the `********` the API shows for it, which
  an import would have stored as the token — and a connection is a name and an
  engine, not a host or a password. *Import* finds this instance's connections
  by id, else by name and engine, and otherwise **asks**, listing the candidates;
  nothing is created until every connection is decided. A bridge that arrives
  without its credential arrives switched off, and says why.
- **Production looks like production, and a connection can be read-only.**
  - An **environment** label on a connection (production / staging /
    development), shown wherever the connection is: the sidebar, next to the
    query editor's Run button, the list a bridge's targets are picked from.
  - The query editor **reads a statement before it sends it**. What cannot be
    taken back — `DROP`, `TRUNCATE`, a `DELETE` or `UPDATE` with no `WHERE`,
    `ALTER … DROP`, Redis `FLUSHALL` / `FLUSHDB`, a MongoDB `$out` — is
    confirmed first, on any connection; on production, so is any write. Strings,
    quoted names and comments are masked first, so a keyword inside one counts
    for nothing and a `DROP` behind a comment is still found.
  - **Read-only connections**: nothing is written through one. The data grid's
    insert / update / delete, every DDL route and restore answer `403`, naming
    the connection. The editor runs a statement only when every part of it is
    recognisably a read (an allowlist: `CALL`, `DO`, `SET` and anything unknown
    are not reads) — and then has the **engine** hold it to that, because the
    text cannot know what a function called from a `SELECT` does: a `READ ONLY`
    transaction on PostgreSQL and MySQL, the prepared statement's own answer on
    SQLite. It cannot be a bridge's destination (refused at save; a connection
    that becomes read-only under a bridge fails the next delivery, saying why) —
    the guard is the adapter itself, so it holds for replays, live bridges and
    dead-letter retries alike. It *can* be a bridge's source: marking production
    read-only and streaming out of it is the point. A guard against accidents,
    not a security boundary; the docs say so.
- **Failure tooling.** Retry **one** failed delivery from its detail panel
  (`POST …/deliveries/:sequence/retry`; on a live bridge it retries the rows
  from the dead-letter queue, re-read from the source). **Download a job's
  failures** as CSV or NDJSON — the rows' keys, the error, attempts, the payload
  that was sent — streamed, and with CSV cells that a spreadsheet would run as a
  formula neutralised. And a **run history strip** on a bridge with more than
  one run: green, amber (finished with failed deliveries), red (stopped by a
  failure); the page used to show the latest run and nothing else. Deliveries
  now carry their operation (`op`) in the API.
- **A delete policy per target.** What a delete at the source does is now each
  target's choice: *delete it here too* (the default), *keep it and mark it as
  deleted* — a column of the target is set to the time of the delete, or to
  `true`, and taken off again by the write that brings the row back — or *do
  nothing*, for an archive or a warehouse that keeps every row it was ever sent.
  One bridge can do all three to three targets. The marker column is created
  with the table when Syncle creates it; for an existing table the dry run says
  when it is missing. A `TRUNCATE` empties only the targets that delete, and the
  delivery's summary says what each target did. API: `onDelete`, `softDelete` on
  a database target.
- **Alerts.** A bridge that stopped at three in the morning said so in one
  place: its own page. *Settings › Alerts* adds channels to say it out loud — a
  **webhook** (JSON, optionally signed: `X-Syncle-Signature: sha256=<hmac of the
  body>`), a **Slack** incoming webhook, or **e-mail** over your SMTP server —
  each subscribed to the events it wants: a bridge or replay stopped by a
  failure (or finished with failed deliveries), a live bridge that lost its
  place in the change log, rows set aside in a dead-letter queue, a bridge
  making its source keep change log.
  - Throttled per channel, event and bridge (`SYNCLE_ALERT_THROTTLE_SECONDS`,
    300): a bridge failing every thirty seconds is one message per window, and
    the next says how many were held back. Sending never blocks or fails a
    bridge; a stop or a cancel somebody asked for is not an alert.
  - A channel's whole configuration is encrypted at rest (a Slack webhook URL
    *is* its credential) and the API never hands a secret back. Alert requests
    are held to the same outbound guard as deliveries; redirects are not
    followed. A *Test* button, and the outcome of the last send on each channel.
- **`GET /api/metrics`** in the Prometheus text format: bridges by trigger,
  jobs by status, deliveries, dead-letter rows and source-retained bytes per
  bridge, component up/down, process memory and event-loop lag. It takes a
  bearer token of its own (`SYNCLE_METRICS_TOKEN`) and does not exist until one
  is set. No new dependency: the format is written by hand.
- **`GET /api/health/ready`**, which is 503 unless the metadata store *and*
  Redis answer. `GET /api/health` now reports both
  (`{ ok, checks: { database, redis } }`) but still fails only on the store: it
  is what the container health check uses, and restarting the API does not bring
  Redis back. Redis is probed on a connection that neither queues nor waits —
  the job queue's own connection would wait for Redis to return instead of
  saying it is gone.
- **`SYNCLE_LOG_LEVEL`** (`error` | `warn` | `log` | `debug` | `verbose`). The
  API logged warnings and errors only, with no way to see its lifecycle lines.
- **Copy what is there, then follow — in one bridge.** A CDC bridge can now
  start from the `beginning`: on its first start it takes its place in the
  source's change log, copies the table through the normal delivery pipeline
  (filters, transforms, batching, the dead-letter queue), and only then opens
  the stream *at the place it took before the copy began*. Nothing that changed
  in between is lost, and no old value read by the copy lands on top of a newer
  one — the two things a replay followed by a separate CDC bridge cannot avoid.
  - PostgreSQL (the slot is the place), MySQL (binlog file and position) and
    MongoDB (the resume token of an empty stream). Redis has no log: it
    subscribes first and holds what it hears, the newest change per key, until
    its keys have been read (`SYNCLE_SNAPSHOT_HOLD_MAX`, default 100,000 keys).
  - The copy is checkpointed like any position: a bridge stopped mid-copy, or a
    Syncle restarted, carries on from the row it had reached. The timeline marks
    where the copy ended and the stream began.
  - It happens once. A bridge with a position resumes from it; "continue from
    now" after a lost position copies nothing — unless asked to
    (`{ "fromNow": true, "recopy": true }`, offered in the UI), which brings
    every row that still exists up to date.
  - A table that cannot be read in a stable order (no primary key, no sort) is
    refused at the start, before anything is touched.
  - Builder: *Start from* on a change-stream trigger. API:
    `trigger.startFrom: "now" | "beginning"` (default `now`).
- **Filters and column transforms in the bridge builder.** Two new sections,
  both saved with the bridge and both applied the same way for a replay, a watch
  and a CDC bridge, into a database or an HTTP destination.
  - *Only rows where…* — a list of conditions (equals, is not, greater / less
    than, contains, starts / ends with, is empty, is not empty). A value typed
    for a numeric or boolean column is sent as a number or a boolean. A
    half-written condition blocks the save rather than quietly becoming "no
    condition", which would send the whole table.
  - *Change values on the way* — an ordered list of steps: **mask** (keep the
    ends, redact, SHA-256 hash with an optional salt, or empty), **convert
    type** (text, number, whole number, boolean, date, JSON), **clean text**
    (trim, lower, upper), **default value**, and **computed column**
    (`{{first}} {{last}}`, with `{{$now}}` and `{{$table}}`). Declarative on
    purpose: there is no expression language and nothing is evaluated.
  - A value that cannot be converted is never decided quietly. Each conversion
    says what happens — fail the delivery (the default), send NULL, or leave the
    value as it was. A failure fails the delivery *before anything is sent*,
    names the column and the value, and on a `continue` bridge sends that one
    row to the dead-letter queue; a retry re-reads the row and runs the steps
    again, so fixing the source is enough.
  - A table Syncle creates is typed for what the columns have **become** — a
    hashed integer is text, a column converted to a date is a timestamp, a plain
    copy is typed like its origin, a column a step can empty is nullable even
    when the source says `NOT NULL` — and the columns the steps add are created
    with it. The dry run shows all of that, with shaped sample rows, first.
  - A hashed key still finds its row: a delete arrives with the plain key and is
    put through the same steps. Delivery records hold the shaped row, so a
    masked value does not reappear in the timeline. On PostgreSQL CDC, a large
    column the server did not resend is read back when a step needs it.
  - The builder's live payload preview applies the steps as you type.
  - API: `transform.columns` on a bridge; an unknown kind is refused, not
    ignored.

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
- **`TRUNCATE` is no longer invisible** (PostgreSQL sources). By default the
  destination keeps its rows and the timeline gets an entry saying the source
  was truncated and that it was not applied — before, the two simply stopped
  matching and nothing said so. Add `truncate` to a bridge's operations to
  empty the destination tables too; it is delivered alone and in order, so rows
  inserted after the truncate are still there afterwards. On engines that do
  not report a truncate as a change, asking for it is refused at start.
- The CDC readiness check shows which columns the table identifies rows by, and
  warns about tables that can only report inserts.
- **Command palette** (⌘K / Ctrl+K, or the search box in the sidebar): go to any
  bridge or connection — by name, or by what it is ("cdc", "postgres") — create
  one, open the data sources or Settings, switch workspace or theme. `cmdk` had
  been a dependency since the first release with nothing using it.
- **Dry run in the builder.** Before a bridge is saved: the table each database
  target would be created as, column by column with the source type beside the
  type it becomes; every column the target cannot hold faithfully; and real
  rows as they would be written or sent. The API could already say all of this
  for a saved bridge and nothing in the UI asked; `POST /api/bridges/preview`
  does it for a draft. Nothing is stored, created or delivered.
- **Connection strings for PostgreSQL, MySQL and Redis** in the connection
  dialog — what a hosted database usually hands you. The adapters always
  accepted one; only MongoDB's form had a field for it. Stored encrypted and
  redacted like a password.
- **Tests for authentication**, which had none: setup token, hashing, sign-in,
  both throttles, cookie flags, tampering, expiry and renewal, the guard — and,
  over real HTTP against the app exactly as production configures it, that every
  one of the 60-odd routes answers 401 without a session except the four that
  are meant to be open. A stray `@Public()` now fails a test.
- **CI runs what matters.** The end-to-end suite against real PostgreSQL, MySQL,
  MongoDB and Redis runs on every pull request, with the CDC spool off and on,
  in a non-UTC time zone — every data-loss bug in this release was found by that
  suite and none of it ran in CI. The API and core packages are linted
  (type-aware ESLint: an unawaited promise is an error) where only the web app
  was; coverage has floors; the web app's unit tests, which the coverage step
  silently skipped, run; and Dependabot watches npm, the docs site, the Actions
  and the base image, leaving the two patched packages alone.
- **A running instance can say which version it is**: `GET /api/version`, and
  the bottom of the Settings dialog. The release build bakes the tag into the
  image (`SYNCLE_VERSION`), and a source checkout reads its package.json — which
  had said 1.0.0 (0.1.0 for the API) through 1.1, 1.2 and 1.3. Every package now
  carries the release version, and a test fails when they disagree or fall
  behind the changelog. `SECURITY.md` no longer describes the project as
  pre-1.0.
- **Source hold**: what a CDC bridge is keeping on its source, in the job view
  and at `GET /api/bridges/:id/source-hold` — for PostgreSQL the WAL pinned by
  its slot, the server's limit, and whether the slot is healthy, at risk or
  lost; for MySQL whether the bridge's binlog file still exists.
- `SYNCLE_SLOT_MAX_BYTES` (off by default): drop the slot of a bridge that is
  *not running* once it pins more than this, to protect the source. A running
  bridge is never touched. `SYNCLE_SLOT_CHECK_SECONDS` sets how often to look.
- `GET /api/bridges/cdc/cleanups` lists replication slots of removed bridges
  that are still to be dropped; `…/retry` tries now, `DELETE …/:id` dismisses
  one that was removed by hand.
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

- **Delivery details are no longer kept for ever.** Every delivery is recorded
  with what was sent and what came back (up to 16 KB each), and nothing ever
  removed those rows: a live bridge doing ten deliveries a second writes 26
  million a month into the metadata store. From this release details are kept
  for **30 days**, and a live (watch / CDC) bridge keeps its newest **100,000**
  deliveries. **Upgrading removes history older than that**, up to 500,000 rows
  per hourly sweep until it has caught up.
  - To keep everything, set both to `0` — in Settings › Engine, or with
    `SYNCLE_DELIVERY_RETENTION_DAYS` / `SYNCLE_DELIVERY_MAX_PER_JOB` — before
    upgrading, or within ten minutes of the new version starting (the first
    sweep waits that long).
  - The delivered / failed / skipped **totals** are stored on the job and do
    not change. A failed delivery whose rows still wait in the dead-letter queue
    is never removed, nor anything belonging to a replay still queued or
    running.
  - A finished replay loses its details all at once, when the job is older than
    the retention — never row by row. On the timeline such deliveries are drawn
    as *delivered, details removed* instead of as queued, and "retry failed" on
    such a job says why it cannot, rather than "no failed rows".
  - `POST /api/bridges/retention/run` applies it now;
    `SYNCLE_RETENTION_SWEEP_MINUTES` sets how often it runs by itself.

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
