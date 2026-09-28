# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.1] - 2026-09-28

### Fixed

- **A database on the machine running Syncle could not be reached by typing
  `localhost`.** It is the first address anyone tries, and on a Docker install
  it was the one address that could never work: inside a container `localhost`
  is the container, where nothing is listening. What came back was the driver's
  own words — `Could not connect to PostgreSQL: connect ECONNREFUSED
  127.0.0.1:5432` — which leaves the reader to already know that a container has
  a loopback of its own, and the docs said to type `host.docker.internal`
  instead. A loopback address is now read as what it plainly means, the database
  on this machine, and dialled at the host: `host.docker.internal` where Docker
  provides that name, the container's own gateway where it does not, or
  `SYNCLE_HOST_GATEWAY` when it is set. `127.0.0.1`, the rest of `127.0.0.0/8`,
  `::1`, `0.0.0.0` and a loopback host inside a connection string are all
  covered, on every engine.
  - It applies on the way to a driver and nowhere else: what is stored and shown
    is the address that was typed, and saving a connection again keeps it.
  - **A connection that tunnels through SSH is left exactly as it was**, because
    there `localhost` is the bastion's own localhost — usually the point of the
    tunnel. The correction runs before the tunnel puts its own loopback address
    in place, never after.
  - A certificate is still checked against the name that was asked for: where a
    loopback host is corrected, it becomes the TLS server name unless one was
    given.
  - `docker-compose.app.yml` now maps `host.docker.internal` to the host
    gateway, so the name resolves on Linux as it already did on Docker Desktop,
    and passes `SYNCLE_HOST_GATEWAY` through like every other setting. The test
    that holds the compose file to the settings the code reads now covers
    `packages/core` as well as the API.

## [1.4.0] - 2026-09-28

The largest release so far, and most of it is correctness. A row that has been
read now reaches its destination, sits in the bridge's dead-letter queue, or is
still ahead of the cursor — never none of the three — and the PostgreSQL, MySQL,
MongoDB and Redis change streams are each tested against a real server for the
ways they used to lose rows without saying anything. Cross-engine types and
values were rebuilt, TLS verifies on every engine, and an SSH tunnel pins the
host key of the hop it exists to protect.

It also has what running Syncle for more than one person needs: accounts with
roles and an activity log of who did what, more than one API process on one
database, a Helm chart, and a page that hears what happens over server-sent
events instead of asking every second.

### Added

- **The page hears what happens instead of asking.** `GET /api/events` is a
  stream of server-sent events — one message per thing that changed, as it
  changes: a bridge, a run, its deliveries, a verification, a dead letter, a
  connection, a workspace, a setting, an account, an API key, an activity-log
  entry, an alert channel. The web app listens to it, and the polls it used to
  live by (a run's deliveries every 1.5 seconds, every bridge's status every 3)
  slow down to a safety net of one every 30 seconds while the stream is up —
  and carry on as before when it is not (a proxy that will not stream). A run's
  progress now shows the moment it is made, on every open tab, from whichever
  API process it happened on. An event says only *that* something changed and
  what it was about; the page asks for the thing itself, so a missed event is a
  little staleness and never a wrong picture. Anything with a session or an API
  key may listen (`curl -N`); the API reference says what the events are.
- **A Helm chart** (`deploy/helm/syncle`): the API, the web GUI, and — unless
  pointed at your own — a PostgreSQL for Syncle's metadata and a Redis for its
  queue, on persistent volumes. The master key is the one value it insists on
  (a key generated inside a pod would be lost with it); external databases,
  ingress with TLS, more than one API replica, every `SYNCLE_*` tunable under
  `api.env`, and the metrics token are values. Linted, rendered and
  schema-checked in CI, and held to the repository's version by a test.
- **More than one account, each with a role — and an activity log that says who
  did what.** There was one account, the admin, and everybody who used Syncle
  used it. Now the admin makes more (Settings › Security › Accounts, or
  `POST /api/auth/users`): an **admin** does everything; an **operator** does
  the work — connections, bridges, runs, the data browser — but nothing about
  accounts, API keys, settings, alert channels or workspaces; a **viewer** looks
  and changes nothing but their own password. A role change takes effect on the
  next request. An account can be disabled (out at once, name and history
  kept), have its password set by an admin, have its sessions ended, or be
  deleted; the last admin that can sign in cannot be demoted, disabled or
  deleted, and nobody deletes the account they are signed in with. The
  password-reset code is asked for by user name (`syncle reset-password <user>`,
  or the field on the login screen); unnamed, it is the first admin's. API keys
  keep their scope: only an admin manages them.
  - **The activity log** (Settings › Activity, `GET /api/audit`): every change
    made through the API — by an account or an API key — and every sign-in,
    succeeded or not, with who (by name as well as by id, so an entry outlives
    the account), what, to what, from which address, and a few words of detail.
    Never a secret: values under names like `password`, `token` or
    `authorization` are redacted before they are written, and the details of a
    connection are its engine, not its credentials. What Syncle does by itself
    (the slot guard giving up a slot) is recorded as *Syncle*. Kept for
    `auditRetentionDays` (default 365, `SYNCLE_AUDIT_RETENTION_DAYS`; 0 = for
    ever), pruned by the retention sweep. An entry that could not be written
    never fails the request.
- **More than one API process on one database is safe — and gives failover.**
  Nothing stopped anybody from running two (a replica, the overlap of a rolling
  deploy), and nothing made it safe: every process resumed every live CDC bridge
  at boot and kept the stream in a table of its own. Two readers per bridge — on
  PostgreSQL the second looped on "replication slot is active", on MySQL both
  connected under the same replication server id and the server threw out one
  after the other, on MongoDB and Redis every change was delivered twice.
  - One process **leads**, by a lease in Redis (`SYNCLE_LEADER_TTL_SECONDS`,
    default 20): it reads the live bridges and runs the periodic sweeps. A
    leader that shuts down hands the lease over at once; one that dies is
    replaced when it runs out. The new leader resumes every live bridge from its
    saved position, so nothing is lost and nothing is delivered twice. A leader
    that cannot renew the lease for as long as it lasts stops reading (it
    fences itself), and reads again when it leads again.
  - Any process can be asked anything: a start or stop of a live bridge that
    reaches another process is relayed to the leader and answered when it is
    done (a start with no leader to hand the stream to is refused, 503, rather
    than shown as "running"); a cancel reaches the process that runs the job; a
    saved setting reaches every process's cache; a polling bridge is polled by
    one process at a time even when a poll outlasts its interval.
  - The first-run setup token is the same whichever process prints it (derived,
    under the master key, from a value kept in the database until an account
    exists) — it also survives a restart before setup is finished.
  - `GET /api/settings/instances`, a panel in Settings that appears when there
    is more than one process (or nobody leads), and `syncle_instance_leader` in
    the metrics.
  With one process nothing changes, except that a Redis outage longer than the
  lease pauses live bridges until Redis is back. See *Running more than one API
  process* in the self-hosting documentation.
- **A row in Redis is a key of its own: a hash, a JSON document or a string,
  under a key you design, with an expiry.** A Redis destination had one shape —
  a column renamed to `key`, a column renamed to `value`, `SET` — which keeps
  one column of a row. A target on a Redis connection now takes a `redis` block
  (the builder shows it as soon as a Redis connection is picked):
  - `keyTemplate` — `user:{{id}}`, `tenant:{{tenant_id}}:user:{{id}}`. The
    columns in it ARE the target's key columns: a delete removes that key, an
    `UPDATE` of a key column moves the row and removes the old key, a row with
    no value for one fails by name instead of landing under half a key. A
    template with no column in it, or with `{{$now}}`, is refused when the
    bridge is saved — as is a template on a target that is not Redis.
  - `type` — `hash` (a field per column; `NULL` = no such field; fields the
    application adds beside them are left alone — written with `HSET`/`HDEL`,
    never `DEL`, so nothing following the keyspace sees the row "deleted" on
    every update), `json` (the row as one document) or `string` (one column).
    A key that is there as another type is replaced.
  - `ttlSeconds` — the key expires that long after its last write.
  - Values are text, as everything in Redis is: a JSON column as its JSON,
    bytes as bytes, a `timestamptz` as ISO-8601 UTC to the microsecond.
  A target without the block works exactly as before.
- **Two bridges can feed each other (A → B plus B → A) without sending a row
  back and forth for ever.** They could be set up, and then never rested: A's
  change is written to B, B's change log reports it, the other bridge writes it
  to A, A's log reports it… measured on two PostgreSQL tables, one `INSERT` by
  a person was delivered about nine times a second in each direction for as long
  as both bridges ran (an upsert of identical values is still a logged change).
  - When a bridge writes to a table that another listening bridge reads, what
    it is about to write is remembered in Syncle's own Redis — per table, per
    row, in order, said *before* the write so that the change cannot come back
    first. The bridge that reads that table looks each change up; a match is
    this instance's own write. Values are compared as what they are, the way
    Verify compares them, so it works across engines; polling (watch) bridges
    and mirrored `TRUNCATE`s are covered as well as CDC.
  - A recognised change carries the tables it has been through, and is only
    kept from going *back* to one: **A ⇄ B** crosses once, a **chain**
    A → B → C still carries every row to the end, a **ring** A → B → C → A
    stops where it began. Through the CDC spool too.
  - Before writing to such a table the bridge looks at what is there: **a row
    that is already exactly what it would be set to is not written** (`wrote 0
    (3 already up to date, not written)`). This is also the safety net — a
    change whose memory expired (`SYNCLE_ECHO_TTL_SECONDS`, default 300) is
    sent on once, finds nothing to change, and the loop dies by itself.
  - Nothing is asked of the source (no replication origins, marker columns or
    triggers), and a bridge whose destination nobody reads pays nothing: no
    look before the write, nothing in Redis. What is remembered is encrypted
    under the master key, used up when the change comes back, and large values
    are remembered by their SHA-256 only. The look before the write does not
    go through Redis, so the safety net holds while Redis is away.
  - A bridge that is tied to another says so on its page, names it, and counts
    what it held back; `GET /api/bridges/:id/loops` says the same. With the
    guard switched off (`SYNCLE_ECHO_TTL_SECONDS=0`) the page warns instead.
  - What it is not: conflict resolution. The same row edited on both sides at
    the same moment can leave the two sides holding each other's value —
    nothing loops, and Verify shows it. Columns the database itself changes on
    every write (a trigger stamping `updated_at`) have to stay out of the
    mapping. See *Two-way sync, and rings* in the bridges documentation.
- **The master key can be changed.** It could not: every stored secret is
  under it, and the documentation said never to touch it. Now: put the new key
  in `SYNCLE_MASTER_KEY` and the old one in `SYNCLE_MASTER_KEY_PREVIOUS`, and
  restart. Both open everything from that moment (the old one only ever
  decrypts), and at start whatever is still under it — connection passwords and
  strings, SSH and TLS secrets, webhook credentials including the copies inside
  resumable jobs, alert channels — is re-encrypted with the new key. When the
  log, *Settings → Security* or `GET /api/settings/encryption` says nothing
  depends on a previous key any more, take it out. There is no moment at which
  anything is unreadable, the pass can be interrupted or repeated, and nobody
  is signed out. An instance that began on a generated `master.key` file and is
  then given a key in its environment needs no previous key at all.

- **A way back in when the password is gone.** Until now a forgotten password
  meant editing the database by hand. *Forgot your password?* on the sign-in
  screen (or `syncle reset-password`) makes the API print a one-time code on
  its console and into `reset-code` in its data directory — being able to read
  it there is the proof of being the operator, as the setup token is on the
  first day — and that code with a new password signs you in and ends every
  other session. The code lives fifteen minutes, works once, dies after ten
  wrong guesses from anywhere, and only its hash is stored. Asking for one
  answers the same whether or not an account exists, and at most one a minute
  is made, so the button can neither probe nor flood the log.

- **Many tables, one PostgreSQL replication slot.** A CDC bridge can read
  through a slot it shares with every other shared bridge on the same
  connection and database (`trigger.slot: "shared"`; *Replication slot* in the
  builder) instead of costing the source a slot, a WAL sender and a decoding of
  its own — a server allows ten of each by default.
  - The slot is confirmed only as far as the slowest member has got, stopped
    members included (their positions are kept in the metadata store), so a
    member that comes back misses nothing; the others drop what is sent again.
  - A member joins behind a barrier: the join waits for the transactions that
    were open when its table was published, so that nothing falls between its
    copy and its stream (`SYNCLE_SHARED_SLOT_JOIN_WAIT_MS`).
  - One publication per set of operations, all made before the slot: an
    insert-only bridge never makes PostgreSQL refuse UPDATEs on a table because
    another bridge publishes updates, and no publication is ever younger than a
    change the slot still has to decode.
  - Source hold, alerts and the WAL guard work per member; the last member to
    go takes the slot with it; switching an existing bridge releases what it
    had and says on its timeline what that means.
- **Bridge many tables at once.** *Bridge many tables* in the bridge list
  (`POST /api/bridges/bulk`): one ordinary bridge per ticked table, copied as
  it is into a same-named (optionally prefixed) table, keyed by its primary
  key. Tables that cannot have one say why. Nothing is started for you.

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

- The benchmark suite covers every engine as a source and every engine as a
  destination — twenty pairs, a million rows each — rather than the three
  engines it started with. Results at
  [syncle.dev/benchmarks](https://syncle.dev/benchmarks), rendered as a
  source-by-destination grid.
- An integration suite covering all twenty pairs against real engines, checking
  the values that arrive rather than the row count, since a mapping that
  transposed two columns would pass a count check.

### Changed

- **A replay of a table with a composite key — or a sort of its own — no
  longer slows down as it goes.** Only a single-column primary key was read by
  keyset (`key > last`); a key of two or more columns, a sort the bridge asked
  for, and a table with no key were read by `OFFSET`, where every page re-reads
  all the pages before it, so a table of a few million rows took hours it had
  no business taking — and a resume after a stop could skip or repeat a row if
  the table had moved. Now a primary key of any width is the keyset (`(a, b) >
  (last a, last b)`), a sort of the bridge's own gets the key appended and is a
  keyset too (unless a sorted column can hold `NULL`, which no comparison can
  place), and a table with no primary key is keyed by a unique index whose
  columns cannot be `NULL` when it has one. The checkpoint is the whole tuple,
  so a canceled or interrupted run picks up at the exact next row. What is
  left — a view, a table with no key and no such index — is read by `OFFSET`
  in the order of all its columns, and the run **says so** on its timeline (a
  notice before the first delivery; a verification puts it on its result):
  rows changed under such a read can be skipped or delivered twice. A change
  stream that copies its table first still refuses a keyless table, as it did.
  The same reader serves verification, so a check of a composite-key copy is
  faster by the same measure. Checkpoints saved by earlier releases stay good:
  a single-column key is read exactly as before.
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

### Fixed

- **A polling watch on a Redis source scanned the keyspace from the top for
  every page.** Redis pages by a cursor of its own (`SCAN`); the watch paged it
  by `OFFSET`, which the adapter can only do by scanning from the start and
  slicing, so a keyspace of a hundred thousand keys was a hundred scans of it
  per poll — and again for the copy of the keys the watch takes when it
  starts. Both now follow the cursor: every key once per poll.
- **Every watch poll left its job record in Redis for ever.** The scheduler's
  job template had no `removeOnComplete`, so a watch polling every second
  wrote 86,400 records a day into the queue's Redis. A poll that is done is now
  gone (a failed one is kept, the last 50), and an API start cleans out the
  records earlier releases left. A start also removes the scheduler of a watch
  whose bridge is gone (one removed while no API process was up to unschedule
  it polled for ever, "bridge not found" every tick), and keeps that of one
  which is listening.
- **A settings listener that threw could end the API process.** A new listener
  is told the current settings once, from a promise nobody awaited; a listener
  that threw there surfaced as an unhandled rejection, which ends a Node
  process by default. Both paths are guarded now, and a listener that
  unsubscribes before the settings were read is not called.
- **The query editor's tabs were named in English whatever the language.**
  "Query 3" is now "Query 3", "Query 3" or "查询 3" as the app is set; a tab
  keeps its number when one before it is closed.
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
  It is now a delete of the old key followed by the new row. "The key" is what
  identifies the row where it is going — the table's primary key and the columns
  the bridge's targets are keyed on — not what PostgreSQL calls the identity: a
  table with `REPLICA IDENTITY FULL` has every column marked as one, and an
  ordinary `UPDATE` there is an update, not a delete and an update.
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
- **A MongoDB CDC bridge reported itself running before its change stream
  existed.** A change stream with no resume token starts wherever the server
  creates its cursor, and the driver creates that cursor on the first read —
  which happened after `start()` had already returned. A document written in
  between was never in the stream and never in the destination, and nothing
  showed it: the bridge was green and a row was simply missing. The window is
  microseconds against a database on the same machine and wide enough to lose
  rows through an SSH tunnel, which is where it was caught. A start now waits
  for the stream to be positioned, as the MySQL binlog reader has since 1.3.0.
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
- **A running PostgreSQL bridge on a quiet table made its source keep the whole
  database's WAL.** PostgreSQL 15 and later do not send a subscriber the
  transactions that touch nothing it publishes — only keepalives. Syncle
  answered those with the position of its last delivery, so on a table that
  rarely changes the slot never moved, and the server kept every byte the
  *other* tables wrote: healthy bridge, nothing to read, disk filling (or, with
  `max_slot_wal_keep_size`, the slot invalidated and the bridge's place lost).
  Measured: forty transactions on another table, slot 20 MB behind, for good.
  A keepalive is now answered with the position the server reports whenever
  nothing the bridge has received is still undelivered — not in the middle of a
  transaction, not while the client still holds data it has not handed over —
  which is what PostgreSQL's own subscribers do. Members of a shared slot move
  the same way; one that is stopped still holds it.
- **Every save of a bridge put a 404 in the browser's console.** The plan of a
  bridge that has not run yet (its draft job) was deleted and made again under
  a new id on each save, and the page that had just saved it asked once more
  for the deliveries of the run it knew. The draft is now refreshed in place;
  leftover duplicates become one.
- **A bridge from Redis to Redis turned every hash, list, set and sorted set
  into the text `[object Object]`** (or a comma-joined string): the destination
  only ever did `SET key String(value)`. A row read from Redis says what kind of
  key it is, and is now written as that — atomically replaced, with the time it
  has left to live. A stream, which cannot be copied as a row, fails and says
  so instead of overwriting the destination's stream with an empty string. A
  column that merely happens to be called `type` or `ttl` (a `settings` table
  synced into Redis) is still just data.

### Security

- **NestJS 11 and Express 5.** The API ran on NestJS 10, whose `@nestjs/core`
  (below 11.1.18) carries a moderate advisory (GHSA-36xv-jgw5-4q75, improper
  neutralisation of special elements) and whose `@nestjs/common` pulls a
  `file-type` with two more (an infinite loop in its ASF parser, a ZIP
  decompression bomb) — none of them reachable the way Syncle uses them, and
  now none of them present: `pnpm audit --prod` is clean. Nothing changes for
  the API's callers: every route, header, cookie and body limit is as it was.
- **Requests that change something must come from the app.** The session is a
  cookie, and `SameSite=Lax` is not the whole answer to cross-site request
  forgery (a sibling subdomain is the same site; older browsers ignore it).
  Anything but `GET`/`HEAD`/`OPTIONS` is now checked before it reaches a route:
  the browser's own `Sec-Fetch-Site: same-origin`, else an `Origin` that is the
  address the app was reached under or one of `WEB_ORIGIN`. A request with no
  `Origin` is not a browser and is unaffected (scripts, API keys). Anything else
  is a `403` — a login with the right password included.
- **Security headers on every response.** API: `nosniff`, `X-Frame-Options:
  DENY`, `Content-Security-Policy: default-src 'none'`, `Referrer-Policy`,
  `Cache-Control: no-store`, and HSTS when the browser came over HTTPS;
  `X-Powered-By` is gone. Web app: a Content-Security-Policy that allows
  script, style, fonts and workers from the app itself only, no framing, a
  `Permissions-Policy` that asks for no device.
- **Nothing is loaded from a CDN any more.** The query editor (Monaco) was
  fetched from jsDelivr at run time: no editor on a network without internet,
  and a third party's script in a page that handles database credentials. It
  is now served by the app (copied out of `node_modules` at build time).

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
