/**
 * Single source for the strings that appear both on the page and in the
 * structured data. Search engines penalise a mismatch between what a page
 * says and what its JSON-LD claims, so they are defined once.
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

/** Doubles as the visible FAQ and the FAQPage structured data. */
export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Which databases can Syncle sync between?',
    a: 'PostgreSQL, MySQL and MariaDB, SQLite, MongoDB and Redis — in any combination. A relational source can write into a document or key-value store and back, with values translated to fit the target. HTTP endpoints work as a destination too, when you are feeding a service rather than a database.',
  },
  {
    q: 'Does it sync in real time, or on a schedule?',
    a: 'Both, and you choose per bridge. CDC reads the database change log directly — Postgres logical replication, MySQL binlog, MongoDB change streams, Redis keyspace notifications — so changes arrive with no polling. Watch polls a cursor instead, which works on every engine. Replay is a one-shot pass for the initial backfill.',
  },
  {
    q: 'Can it duplicate or lose rows?',
    a: 'Writes are idempotent upserts keyed by the columns you pick, so a replay, a retry or a redelivery rewrites the same row rather than adding another. Deletes propagate as deletes. Jobs record their cursor as they go, so an interrupted run resumes where it stopped instead of starting over.',
  },
  {
    q: 'What do I need installed to run it?',
    a: 'Docker, and nothing else. Node, PostgreSQL and Redis all run in containers, and the application image is pulled prebuilt for your architecture, so nothing is compiled on your machine. One command installs it, starts it and opens the web interface.',
  },
  {
    q: 'Is Syncle free, and is my data sent anywhere?',
    a: 'It is MIT licensed and entirely self-hosted. It runs on your own machine against your own databases; there is no account, no telemetry and no third-party service in the path. Stored connection credentials are encrypted with a key that never leaves your install.',
  },
  {
    q: 'How is it different from Airbyte or Debezium?',
    a: 'Scale of setup. Airbyte expects Kubernetes and a team to operate it; Debezium expects Kafka. Syncle is a single command, four containers and a web interface, aimed at one operator who wants two databases kept in step without standing up a data platform first.',
  },
];


/** Real jobs people reach for a sync tool to do. `tag` names the trigger. */
export const USE_CASES: { title: string; body: string; tag: string }[] = [
  {
    title: 'Migrate to a different engine',
    tag: 'Replay + CDC',
    body: 'Sync PostgreSQL to MySQL, or MySQL to Postgres: backfill every row with a replay job, then leave a CDC bridge running so the two stay identical while you cut traffic over. Nothing has to be offline for it.',
  },
  {
    title: 'Feed a read replica you actually control',
    tag: 'CDC',
    body: 'Keep a second database in step for reporting or exports without pointing analysts at production — database replication you can shape, without the managed-service bill.',
  },
  {
    title: 'Warm a cache from the source of truth',
    tag: 'CDC',
    body: 'Project rows straight into Redis as they change, keyed however you like, so the cache is never the thing that went stale. Deletes remove the key rather than leaving it to expire.',
  },
  {
    title: 'Give search its own copy',
    tag: 'Watch',
    body: 'Postgres to MongoDB replication for the columns a search index needs, reshaped on the way across, without bolting write hooks onto the application.',
  },
  {
    title: 'Split a monolith database',
    tag: 'CDC',
    body: 'Carve a table out to a new service database and keep both in sync while callers move over one at a time, instead of coordinating a single risky switch.',
  },
  {
    title: 'Push rows to a service, not a database',
    tag: 'Any',
    body: 'Send each change to an HTTP endpoint with a payload you design, with retries and backoff, when what you need fed is an API rather than another store.',
  },
];

/** How Syncle sits against the tools people already know. */
export const COMPARISON: {
  aspect: string;
  syncle: string;
  airbyte: string;
  debezium: string;
}[] = [
  {
    aspect: 'To get running',
    syncle: 'One command',
    airbyte: 'Kubernetes or Docker Compose',
    debezium: 'Kafka and Connect',
  },
  {
    aspect: 'Moving parts',
    syncle: 'Four containers',
    airbyte: 'A platform',
    debezium: 'A broker and a cluster',
  },
  {
    aspect: 'Real-time capture',
    syncle: 'Built in, per bridge',
    airbyte: 'On some connectors',
    debezium: 'The whole point',
  },
  {
    aspect: 'Writes to the destination',
    syncle: 'Direct, idempotent upserts',
    airbyte: 'Through its own staging',
    debezium: 'You write the consumer',
  },
  {
    aspect: 'Interface',
    syncle: 'Web GUI, no config files',
    airbyte: 'Web GUI',
    debezium: 'Config and code',
  },
  {
    aspect: 'Aimed at',
    syncle: 'One operator',
    airbyte: 'A data team',
    debezium: 'A platform team',
  },
];

/** What happens to credentials and data. */
export const SECURITY: { title: string; body: string }[] = [
  {
    title: 'Your data never leaves',
    body: 'Syncle runs on your machine and talks to your databases directly. There is no account, no telemetry, and no third party in the path — the rows go from your source to your destination and nowhere else.',
  },
  {
    title: 'Credentials are encrypted at rest',
    body: 'Saved connection details are sealed with AES-256-GCM under a key generated at install, which stays on the host. Losing the key costs you the stored secrets rather than exposing them.',
  },
  {
    title: 'One operator, guarded from the first request',
    body: 'The admin account is created with a one-time token printed on the server, so an instance reachable before you set it up cannot be claimed by whoever finds it first. Login is rate limited.',
  },
  {
    title: 'Reach private databases over SSH',
    body: 'Connect through a bastion to databases that never listen on a public interface, so nothing has to be exposed to make a bridge work.',
  },
];
