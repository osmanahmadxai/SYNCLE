/**
 * an engine's own words, read for what they mean — each line here is how a real
 * driver (or Syncle) says it.
 */
import { describe, expect, it } from 'vitest';
import { causeOf, type ErrorCause } from './error-causes';

const cases: [ErrorCause, string][] = [
  // the one that started it: an update inserted a second time
  [
    'duplicate-key',
    'customers: duplicate key value violates unique constraint "customers_pkey" — 1 row moved to the dead-letter queue',
  ],
  ['duplicate-key', "Duplicate entry '1' for key 'customers.PRIMARY'"],
  [
    'duplicate-key',
    'E11000 duplicate key error collection: shop.customers index: _id_ dup key: { _id: 1 }',
  ],
  ['duplicate-key', 'UNIQUE constraint failed: customers.id'],
  [
    'schema-changed',
    'The source table "customers" has changed, and this bridge uses a column that is gone: plan.',
  ],
  [
    'transform-failed',
    'Column transform failed — "age": "abc" is not a number',
  ],
  ['missing-column', 'column "plan" of relation "customers" does not exist'],
  ['missing-column', "Unknown column 'plan' in 'field list'"],
  ['missing-column', 'table customers has no column named plan'],
  ['missing-table', 'relation "public.customers" does not exist'],
  ['missing-table', "Table 'shop_replica.customers' doesn't exist"],
  ['missing-table', 'no such table: customers'],
  [
    'not-null',
    'null value in column "email" of relation "customers" violates not-null constraint',
  ],
  ['not-null', "Column 'email' cannot be null"],
  [
    'foreign-key',
    'insert or update on table "orders" violates foreign key constraint "orders_customer_id_fkey"',
  ],
  ['bad-value', 'invalid input syntax for type integer: "abc"'],
  ['bad-value', "Data too long for column 'name' at row 1"],
  ['cdc-not-enabled', 'logical decoding requires wal_level >= logical'],
  [
    'cdc-not-enabled',
    'The $changeStream stage is only supported on replica sets',
  ],
  ['slots-exhausted', 'all replication slots are in use'],
  ['auth-failed', 'password authentication failed for user "syncle"'],
  [
    'auth-failed',
    "Access denied for user 'syncle'@'172.17.0.1' (using password: YES)",
  ],
  [
    'auth-failed',
    'WRONGPASS invalid username-password pair or user is disabled.',
  ],
  ['permission-denied', 'permission denied for table customers'],
  [
    'permission-denied',
    'not authorized on shop to execute command { find: "customers" }',
  ],
  ['tls', 'self-signed certificate in certificate chain'],
  ['host-not-found', 'getaddrinfo ENOTFOUND db.internal'],
  [
    'connection-refused',
    'Could not connect to PostgreSQL: connect ECONNREFUSED 127.0.0.1:5432',
  ],
  ['timeout', 'connect ETIMEDOUT 10.0.0.5:3306'],
  ['http-auth', 'HTTP 401 Unauthorized'],
  ['http-not-found', 'HTTP 404 Not Found'],
  ['http-rate-limited', 'HTTP 429 Too Many Requests'],
  ['http-client-error', 'HTTP 422 Unprocessable Entity'],
  ['http-server-error', 'HTTP 503 Service Unavailable'],
  ['unknown', 'something nobody has seen before'],
];

describe('what an error means', () => {
  it.each(cases)('%s ← %s', (cause, error) => {
    expect(causeOf(error)).toBe(cause);
  });

  it('says nothing about no error', () => {
    expect(causeOf(null)).toBe('unknown');
    expect(causeOf('')).toBe('unknown');
  });
});
