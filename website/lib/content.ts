/**
 * Single source for the strings that appear both on the page and in the
 * structured data. A page whose JSON-LD disagrees with its visible text gets
 * penalised for it, so both read from here.
 */

export const SITE_URL = 'https://syncle.dev';
export const GITHUB = 'https://github.com/osmanahmadxai/SYNCLE';
export const AUTHOR_GITHUB = 'https://github.com/osmanahmadxai';
export const INSTALL_COMMAND =
  'curl -fsSL https://syncle.dev/install | sh -s -- up';

export const TITLE =
  'Syncle — keep any databases in sync, live, across engines';

/** ~155 chars, intent phrases front-loaded — this is the SERP snippet */
export const DESCRIPTION =
  'Open-source, self-hosted database sync with real-time CDC — PostgreSQL, MySQL, SQLite, MongoDB and Redis, any engine to any other. One command to install.';

/**
 * Doubles as the visible FAQ and the FAQPage structured data. Every claim
 * here is checked against the product repo, and where a feature has an edge
 * case the edge case is in the answer.
 */
export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Which databases can Syncle sync between?',
    a: 'PostgreSQL, MySQL, SQLite, MongoDB and Redis, in any combination. A relational source can write into a document or key-value store and back again, with values translated to fit the target. HTTP endpoints work as a destination too, for when you are feeding a service rather than a database.',
  },
  {
    q: 'Does it sync in real time, or on a schedule?',
    a: 'You choose per bridge. CDC reads the database change log directly — Postgres logical replication, MySQL binlog, MongoDB change streams, Redis keyspace notifications — so changes arrive without polling. Watch polls a cursor instead, which works on every engine, including SQLite, which has no change log to read. The cursor can be an auto-increment id, a timestamp column, or a diff of the primary keys, so a table with no updated_at column can still be watched. Replay is a one-shot pass, for the initial backfill.',
  },
  {
    q: 'Can it duplicate or lose rows?',
    a: 'Writes are idempotent upserts keyed by the columns you pick, so a replay, a retry or a redelivery rewrites the same row rather than adding another. Jobs record their cursor as they go, so an interrupted run resumes where it stopped. What each trigger can see differs, though: a CDC bridge propagates inserts, updates and deletes, while a watch bridge polls, so it sees new rows (and updates, on a timestamp cursor) but never deletes. And Redis CDC rides keyspace notifications, which are not durable — if Syncle is down when a Redis key changes, that event is gone.',
  },
  {
    q: 'What do I need installed to run it?',
    a: 'Docker with Compose v2, and curl for the installer. That is what the install script checks for before it will run. Node, PostgreSQL and Redis all run in containers, and the application image is pulled prebuilt, so nothing is compiled on your machine.',
  },
  {
    q: 'Is Syncle free, and is my data sent anywhere?',
    a: 'It is MIT licensed and entirely self-hosted. It runs on your own machine against your own databases; there is no account and no third-party service in the data path. Stored connection credentials are encrypted with AES-256-GCM under a key that never leaves your install.',
  },
  {
    q: 'How is it different from Airbyte or Debezium?',
    a: 'Mainly in where the rows end up. Debezium writes change events into a Kafka topic, so you run the broker and you still build or configure the thing that consumes it and writes to your destination. Syncle writes to the destination itself. Airbyte expects a platform deployment — Kubernetes, or Docker Compose at smaller scale — and a team to operate it. Both are built for organisations running pipelines as a discipline, and if that is you, they are the better fit. Syncle is one command, four containers and a web interface, for one operator who wants two databases to match without standing up a data platform first.',
  },
  {
    q: 'How much can it move?',
    a: 'A million rows, cross-engine, in well under a minute on a laptop, each arriving exactly once. Rather than quote a figure here that goes stale the moment the code moves, the measured results live on the benchmarks page, along with the machine they were taken on and the runner that produced them. The pattern behind the numbers: round trips set the pace, not the database, which is why work is sent in batches rather than a row at a time. There is no published benchmark against a managed or remote database yet, and latency dominates there.',
  },
  {
    q: 'What happens if the destination goes down?',
    a: 'By default the reader stops advancing, which means the source keeps its change log until the destination is back. That is safe, but on PostgreSQL a long outage leaves WAL accumulating on the source. Turning on the optional spool changes that: changes are written to a durable Redis stream first and the source is acknowledged immediately, so its log advances at the speed of Redis rather than the destination. The spool is bounded, so a stalled destination throttles the reader instead of growing without limit. It is off by default, because while a change sits in the spool Redis holds the only copy of it, and that trade-off should be a deliberate one.',
  },
];

/** Real jobs people reach for a sync tool to do. `tag` names the trigger. */
export const USE_CASES: { title: string; body: string; tag: string }[] = [
  {
    title: 'Migrate to a different engine',
    tag: 'Replay + CDC',
    body: 'Backfill every row with a replay job, then leave a CDC bridge running so old and new stay identical while you cut traffic over. Nothing has to go offline for it.',
  },
  {
    title: 'Keep a reporting copy up to date',
    tag: 'CDC',
    body: 'Keep a second database in step for reporting or exports, so analysts are not querying production and you are not paying for a managed replica.',
  },
  {
    title: 'Warm a cache from the source of truth',
    tag: 'CDC',
    body: 'Project rows into Redis as they change, keyed however you like. Deletes remove the key rather than leaving it to expire.',
  },
  {
    title: 'Give search its own copy',
    tag: 'Watch',
    body: 'Sync the columns a search index needs into MongoDB, reshaped on the way across, without bolting write hooks onto the application.',
  },
  {
    title: 'Split a monolith database',
    tag: 'CDC',
    body: 'Carve a table out to a new service database and keep both in sync while callers move over one at a time, instead of coordinating a single risky switch.',
  },
  {
    title: 'Push rows to a service, not a database',
    tag: 'Any',
    body: 'Send each change to an HTTP endpoint with a payload you design, with retries and backoff, when the thing to feed is an API rather than another store.',
  },
];
