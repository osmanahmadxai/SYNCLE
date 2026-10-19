/**
 * what an error most likely MEANS. a delivery or a run fails with the driver's
 * own words — `duplicate key value violates unique constraint "customers_pkey"`,
 * `Access denied for user`, `E11000` — which say what went wrong to someone who
 * already knows each engine, and nothing to anyone else. this names the cause
 * once, in Syncle's terms, so a suggestion can say what to do about it.
 *
 * each pattern is the wording of a real engine or of Syncle itself; the first
 * that matches wins, so the narrow ones come before the broad ones.
 */
export type ErrorCause =
  | 'duplicate-key'
  | 'schema-changed'
  | 'transform-failed'
  | 'missing-table'
  | 'missing-column'
  | 'not-null'
  | 'foreign-key'
  | 'bad-value'
  | 'cdc-not-enabled'
  | 'slots-exhausted'
  | 'auth-failed'
  | 'permission-denied'
  | 'tls'
  | 'host-not-found'
  | 'connection-refused'
  | 'timeout'
  | 'http-auth'
  | 'http-not-found'
  | 'http-rate-limited'
  | 'http-client-error'
  | 'http-server-error'
  | 'unknown';

const CAUSES: [ErrorCause, RegExp][] = [
  [
    'duplicate-key',
    // PostgreSQL · MySQL · MongoDB · SQLite
    /duplicate key value violates unique constraint|Duplicate entry .* for key|E11000 duplicate key|UNIQUE constraint failed/i,
  ],
  [
    'schema-changed',
    /source table .* has changed|stopped: its source table changed/i,
  ],
  ['transform-failed', /Column transform failed/i],
  [
    'missing-column',
    /column "[^"]+" (of relation "[^"]+" )?does not exist|Unknown column|has no column named|no such column/i,
  ],
  [
    'missing-table',
    /relation "[^"]+" does not exist|Table '[^']+' doesn't exist|no such table|ns not found|Unknown database/i,
  ],
  [
    'not-null',
    /violates not-null constraint|cannot be null|NOT NULL constraint failed|doesn't have a default value/i,
  ],
  [
    'foreign-key',
    /violates foreign key constraint|a foreign key constraint fails|FOREIGN KEY constraint failed/i,
  ],
  [
    'bad-value',
    /invalid input syntax for type|Incorrect \w+ value|Data too long|value too long for type|out of range|Out of range value|datatype mismatch/i,
  ],
  [
    'cdc-not-enabled',
    /wal_level|logical decoding|binlog_format|binary log(ging)? is not enabled|binlog_row_image|only supported on replica sets|change streams? .*replica set|notify-keyspace-events/i,
  ],
  [
    'slots-exhausted',
    /all replication slots are in use|max_replication_slots|max_wal_senders/i,
  ],
  [
    'auth-failed',
    /password authentication failed|Access denied for user|Authentication failed|WRONGPASS|NOAUTH|invalid username.password/i,
  ],
  [
    'permission-denied',
    /permission denied|command denied to user|not authorized on|must be superuser|must have REPLICATION|REPLICATION SLAVE|NOPERM/i,
  ],
  [
    'tls',
    /self[- ]signed certificate|certificate|SSL|TLS|does not support SSL|unable to verify the first certificate/i,
  ],
  [
    'host-not-found',
    /ENOTFOUND|getaddrinfo|EAI_AGAIN|Name or service not known/i,
  ],
  [
    'connection-refused',
    /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|Could not connect|Connection refused|connection terminated/i,
  ],
  ['timeout', /ETIMEDOUT|timed? ?out|timeout/i],
  ['http-auth', /HTTP 40[13]\b/],
  ['http-not-found', /HTTP 404\b|HTTP 410\b/],
  ['http-rate-limited', /HTTP 429\b/],
  ['http-client-error', /HTTP 4\d\d\b/],
  ['http-server-error', /HTTP 5\d\d\b/],
];

/** the most likely cause of an error, or `unknown` */
export function causeOf(error: string | null | undefined): ErrorCause {
  if (!error) return 'unknown';
  for (const [cause, pattern] of CAUSES) if (pattern.test(error)) return cause;
  return 'unknown';
}
