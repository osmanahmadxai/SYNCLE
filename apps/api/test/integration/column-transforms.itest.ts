/**
 * Column transforms, end to end: masking, casts and computed columns on real
 * rows, into real tables and a real HTTP receiver.
 *
 * The unit tests say what a transform does to a value. These say what that
 * means for a bridge: the table that gets created has to fit what the columns
 * have BECOME, a key that is hashed has to still find its row on an update and
 * on a delete, and the masked value must not survive anywhere Syncle keeps a
 * record of what it delivered.
 */
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
} from './app-harness';

let app: AppHandle;
let jobs: any;
let controller: any;
let pg: string;
let pgDest: string;
let mysqlDest: string;
const cleanups: Array<() => Promise<void>> = [];

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  jobs = app.ctx.get(BridgeJobService);
  controller = app.ctx.get(BridgesController);
  pg = await connectionFor(app, 'postgres');
  pgDest = await connectionFor(app, 'postgres_dest');
  mysqlDest = await connectionFor(app, 'mysql_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const src = (sql: string) => withAdapter('postgres', (a) => a.query(sql));

async function customers(): Promise<string> {
  const table = uniqueTable('xf_src');
  await src(
    `CREATE TABLE "${table}" (id integer PRIMARY KEY, email text NOT NULL, card text, joined text, active text, balance text, first text, last text);
     INSERT INTO "${table}" VALUES
       (1, ' Ada@Example.com ', '4111111111111111', '2026-01-02T03:04:05Z', 'yes', '12.50', 'Ada', 'Lovelace'),
       (2, 'grace@example.com', NULL, NULL, 'no', 'n/a', 'Grace', 'Hopper')`,
  );
  cleanups.push(() =>
    src(`DROP TABLE IF EXISTS "${table}" CASCADE`).then(() => undefined),
  );
  return table;
}

const TRANSFORMS = [
  { kind: 'text', column: 'email', op: 'trim' },
  { kind: 'text', column: 'email', op: 'lower' },
  { kind: 'mask', column: 'card', mode: 'partial' },
  { kind: 'cast', column: 'joined', to: 'date' },
  { kind: 'cast', column: 'active', to: 'boolean' },
  // row 2 says "n/a": that is no number, and here it is allowed to become NULL
  { kind: 'cast', column: 'balance', to: 'number', onError: 'null' },
  { kind: 'set', column: 'full_name', template: '{{first}} {{last}}' },
  { kind: 'default', column: 'tier', value: 'standard' },
];

async function bridge(opts: {
  source: string;
  destConn: string;
  dest: string;
  keyColumns?: string[];
  columns: unknown[];
  mapping: string[];
  trigger?: unknown;
  createMissingTable?: boolean;
}): Promise<string> {
  const { bridgeInputSchema } = await import('@syncle/core');
  const created = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-xf-${opts.dest}`,
      source: {
        kind: 'table',
        connectionId: pg,
        table: opts.source,
        sort: [{ column: 'id', direction: 'asc' }],
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: opts.destConn,
            table: opts.dest,
            keyColumns: opts.keyColumns ?? ['id'],
            mapping: opts.mapping.map((c) => ({ source: c, target: c })),
            createMissingTable: opts.createMissingTable ?? true,
          },
        ],
      },
      transform: { columns: opts.columns },
      delivery: { batchSize: 10 },
      trigger: opts.trigger ?? { kind: 'replay' },
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(created.id).catch(() => undefined);
    await app.cdc.cleanup(created.id).catch(() => undefined);
  });
  return created.id;
}

async function replay(bridgeId: string): Promise<{ id: string }> {
  const started = await jobs.start(bridgeId);
  await waitFor(`replay ${started.id}`, async () => {
    const j = await app.prisma.bridgeJob.findUnique({
      where: { id: started.id },
    });
    if (
      j?.status === 'failed' ||
      (j?.status === 'completed' && j.failedCount > 0)
    ) {
      const bad = await app.prisma.bridgeDelivery.findFirst({
        where: { jobId: j.id, status: 'failed' },
      });
      throw new Error(`replay ${j.status}: ${bad?.error ?? j.error}`);
    }
    return j?.status === 'completed' ? j : null;
  });
  return started;
}

describe('a replay into a table Syncle creates', () => {
  it('writes the shaped rows, into columns typed for what the values have become', async () => {
    const source = await customers();
    const dest = uniqueTable('xf_dst');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const id = await bridge({
      source,
      destConn: pgDest,
      dest,
      columns: TRANSFORMS,
      mapping: [
        'id',
        'email',
        'card',
        'joined',
        'active',
        'balance',
        'full_name',
        'tier',
      ],
    });
    const job = await replay(id);

    const rows = await destRows('postgres_dest', dest);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 1,
      email: 'ada@example.com',
      card: '************1111',
      active: true,
      balance: 12.5,
      full_name: 'Ada Lovelace',
      tier: 'standard',
    });
    expect(String(rows[0]!.joined)).toMatch(/^2026-01-02/);
    // "n/a" is not a number; this cast was told to write NULL for such a value
    expect(rows[1]).toMatchObject({
      id: 2,
      card: null,
      active: false,
      balance: null,
      full_name: 'Grace Hopper',
    });

    // the table was created for what the columns BECAME, not what the source says
    const types = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${dest}'`,
      ),
    );
    const typeOf = Object.fromEntries(
      types.rows.map((r) => [r.column_name, r.data_type]),
    );
    expect(typeOf).toMatchObject({
      id: 'integer',
      active: 'boolean',
      balance: 'double precision',
      joined: 'timestamp with time zone',
      full_name: 'text',
      tier: 'text',
    });

    // and the card number is nowhere in what Syncle recorded of the delivery
    const deliveries = await app.prisma.bridgeDelivery.findMany({
      where: { jobId: job.id },
    });
    expect(deliveries.length).toBeGreaterThan(0);
    expect(JSON.stringify(deliveries)).not.toContain('4111111111111111');
    expect(JSON.stringify(deliveries)).toContain('************1111');
  });

  it('carries a cast date into MySQL, which does not take an ISO string as it stands', async () => {
    const source = await customers();
    const dest = uniqueTable('xf_my');
    cleanups.push(() =>
      withAdapter('mysql_dest', (a) => a.dropTable(dest)).then(() => undefined),
    );
    const id = await bridge({
      source,
      destConn: mysqlDest,
      dest,
      columns: [
        { kind: 'cast', column: 'joined', to: 'date' },
        { kind: 'cast', column: 'active', to: 'boolean' },
        { kind: 'mask', column: 'email', mode: 'hash' },
      ],
      mapping: ['id', 'email', 'joined', 'active'],
    });
    await replay(id);
    const rows = await destRows('mysql_dest', dest);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.email).toBe(sha(' Ada@Example.com '));
    expect(String(rows[0]!.joined)).toMatch(/2026-01-02/);
    expect([true, 1]).toContain(rows[0]!.active);
    expect(rows[1]!.joined).toBeNull();
  });
});

describe('a bridge with no explicit mapping (the whole row, same names)', () => {
  const STEPS = [
    // NOT NULL at the source; every value becomes NULL on the way
    { kind: 'mask', column: 'ssn', mode: 'null' },
    // plain copies: typed like what they copy, and converted like it too
    { kind: 'set', column: 'price_was', template: '{{price}}' },
    { kind: 'set', column: 'seen_copy', template: '{{seen}}' },
    { kind: 'set', column: 'synced_at', template: '{{$now}}' },
    { kind: 'cast', column: 'synced_at', to: 'date' },
    { kind: 'set', column: 'label', template: 'row {{id}}' },
  ];

  async function strictSource(): Promise<string> {
    const table = uniqueTable('xf_ident');
    await src(
      `CREATE TABLE "${table}" (id integer PRIMARY KEY, ssn text NOT NULL, price numeric(10,2) NOT NULL, seen timestamptz NOT NULL);
       INSERT INTO "${table}" VALUES (1, '078-05-1120', 19.99, '2026-03-04T05:06:07Z'), (2, '219-09-9999', 5.00, '2026-03-05T00:00:00Z')`,
    );
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${table}" CASCADE`).then(() => undefined),
    );
    return table;
  }

  it('creates the columns the steps ADD, types a copy like its origin, and lets an emptied column be empty', async () => {
    const source = await strictSource();
    const dest = uniqueTable('xf_ident_dst');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const id = await bridge({
      source,
      destConn: pgDest,
      dest,
      columns: STEPS,
      mapping: [],
    });
    await replay(id);

    const rows = (await destRows('postgres_dest', dest)).sort(
      (a, b) => Number(a.id) - Number(b.id),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 1, ssn: null, label: 'row 1' });
    expect(Number(rows[0]!.price_was)).toBe(19.99);
    expect(new Date(String(rows[0]!.seen_copy)).toISOString()).toBe(
      '2026-03-04T05:06:07.000Z',
    );
    expect(
      Date.now() - new Date(String(rows[0]!.synced_at)).getTime(),
    ).toBeLessThan(120_000);

    const columns = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${dest}'`,
      ),
    );
    const shape = Object.fromEntries(
      columns.rows.map((r) => [r.column_name, [r.data_type, r.is_nullable]]),
    );
    expect(shape).toMatchObject({
      id: ['integer', 'NO'],
      // the source says NOT NULL. a column that is always emptied cannot be
      ssn: ['text', 'YES'],
      price: ['numeric', 'NO'],
      price_was: ['numeric', 'NO'],
      seen_copy: ['timestamp with time zone', 'NO'],
      synced_at: ['timestamp with time zone', 'YES'],
      label: ['text', 'YES'],
    });
  });

  it('the same into MySQL, where a timestamp — copied or made from {{$now}} — has to be respelled', async () => {
    const source = await strictSource();
    const dest = uniqueTable('xf_ident_my');
    cleanups.push(() =>
      withAdapter('mysql_dest', (a) => a.dropTable(dest)).then(() => undefined),
    );
    const id = await bridge({
      source,
      destConn: mysqlDest,
      dest,
      columns: STEPS,
      mapping: [],
    });
    await replay(id);

    const rows = (await destRows('mysql_dest', dest)).sort(
      (a, b) => Number(a.id) - Number(b.id),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ id: 2, ssn: null, label: 'row 2' });
    expect(Number(rows[1]!.price_was)).toBe(5);
    expect(String(rows[0]!.seen_copy)).toMatch(/2026-03-04/);
    expect(rows[0]!.synced_at).not.toBeNull();
  });
});

describe('a value that cannot be cast', () => {
  it('fails the delivery by default, and says which column and value — not the destination’s guess at it', async () => {
    const source = await customers();
    const dest = uniqueTable('xf_strict');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const id = await bridge({
      source,
      destConn: pgDest,
      dest,
      columns: [{ kind: 'cast', column: 'balance', to: 'number' }],
      mapping: ['id', 'balance'],
    });
    const started = await jobs.start(id);
    const failed = await waitFor('the job to stop', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: started.id },
      });
      return j && ['failed', 'completed'].includes(j.status) ? j : null;
    });
    const bad = await app.prisma.bridgeDelivery.findFirst({
      where: { jobId: failed.id, status: 'failed' },
    });
    expect(bad?.error).toMatch(
      /Column transform failed — cast balance: "n\/a" is not a number/,
    );
    // nothing of that batch was attempted
    expect(bad?.attempts).toBe(0);
  });

  it('on a live bridge set to continue, only THAT row is set aside', async () => {
    const source = uniqueTable('xf_dlq');
    const dest = uniqueTable('xf_dlq_dst');
    await src(`CREATE TABLE "${source}" (id integer PRIMARY KEY, amount text)`);
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-xf-${dest}`,
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: dest,
              keyColumns: ['id'],
              mapping: ['id', 'amount'].map((c) => ({ source: c, target: c })),
              createMissingTable: true,
            },
          ],
        },
        transform: {
          columns: [{ kind: 'cast', column: 'amount', to: 'number' }],
        },
        delivery: { onError: 'continue' },
        trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(created.id).catch(() => undefined);
      await app.cdc.cleanup(created.id).catch(() => undefined);
    });
    await app.cdc.start(created.id);
    await src(
      `INSERT INTO "${source}" VALUES (1, '10'), (2, 'n/a'), (3, '30.5')`,
    );

    await waitFor('the good rows', async () => {
      const ids = (await destRows('postgres_dest', dest)).map((r) =>
        Number(r.id),
      );
      return ids.length === 2 ? ids : null;
    });
    expect(
      (await destRows('postgres_dest', dest)).map((r) => [
        Number(r.id),
        Number(r.amount),
      ]),
    ).toEqual([
      [1, 10],
      [3, 30.5],
    ]);
    const parked = await waitFor('the dead letter', async () => {
      const letters = await app.prisma.bridgeDeadLetter.findMany({
        where: { bridgeId: created.id, status: 'pending' },
      });
      return letters.length ? letters : null;
    });
    expect(parked).toHaveLength(1);
    expect(parked[0].error).toMatch(/cast amount: "n\/a" is not a number/);
    // parked as the SOURCE has it, so that a retry re-reads and re-shapes it
    expect(parked[0].rowsJson).toContain('n/a');
  });
});

describe('a row set aside because of a transform', () => {
  it('is retried THROUGH the transforms: still refused while the source says "n/a", delivered — hashed once — when it is fixed', async () => {
    const source = uniqueTable('xf_retry');
    const dest = uniqueTable('xf_retry_dst');
    await src(
      `CREATE TABLE "${source}" (id integer PRIMARY KEY, amount text, email text)`,
    );
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const { DeadLetterService } =
      await import('../../src/bridges/dead-letter.service');
    const deadLetters = app.ctx.get(DeadLetterService);
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-xf-${dest}`,
        source: { kind: 'table', connectionId: pg, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: dest,
              keyColumns: ['id'],
              mapping: ['id', 'amount', 'email'].map((c) => ({
                source: c,
                target: c,
              })),
              createMissingTable: true,
            },
          ],
        },
        transform: {
          columns: [
            { kind: 'cast', column: 'amount', to: 'number' },
            { kind: 'mask', column: 'email', mode: 'hash' },
          ],
        },
        delivery: { onError: 'continue' },
        trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(created.id).catch(() => undefined);
      await app.cdc.cleanup(created.id).catch(() => undefined);
    });
    await app.cdc.start(created.id);
    await src(
      `INSERT INTO "${source}" VALUES (1, '10', 'ada@example.com'), (2, 'n/a', 'grace@example.com')`,
    );
    await waitFor('the dead letter', async () =>
      (await app.prisma.bridgeDeadLetter.count({
        where: { bridgeId: created.id, status: 'pending' },
      })) === 1
        ? true
        : null,
    );

    // nothing has changed at the source: the retry re-reads "n/a" and says so again
    expect(await deadLetters.retry(created.id, { force: false })).toMatchObject(
      { resolved: 0, stillFailing: 1 },
    );
    const still = await app.prisma.bridgeDeadLetter.findFirst({
      where: { bridgeId: created.id },
    });
    expect(still?.status).toBe('pending');
    expect(still?.error).toMatch(/cast amount: "n\/a" is not a number/);
    expect(
      (await destRows('postgres_dest', dest)).map((r) => Number(r.id)),
    ).toEqual([1]);

    // stopped, so that what delivers the fixed row is the retry and not the stream
    await app.cdc.stop(created.id);
    await src(`UPDATE "${source}" SET amount = '20.25' WHERE id = 2`);
    expect(await deadLetters.retry(created.id, { force: false })).toMatchObject(
      { resolved: 1, stillFailing: 0 },
    );

    const rows = (await destRows('postgres_dest', dest)).sort(
      (a, b) => Number(a.id) - Number(b.id),
    );
    expect(rows.map((r) => [Number(r.id), Number(r.amount)])).toEqual([
      [1, 10],
      [2, 20.25],
    ]);
    // hashed ONCE: a retry that shaped an already-shaped row would have hashed the hash
    expect(rows[1]!.email).toBe(sha('grace@example.com'));
    expect(rows[1]!.email).not.toBe(sha(sha('grace@example.com')));
  });
});

describe('a bridge that polls', () => {
  it('filters at the source and shapes what it finds, like any other', async () => {
    const source = uniqueTable('xf_poll');
    const dest = uniqueTable('xf_poll_dst');
    await src(
      `CREATE TABLE "${source}" (id integer PRIMARY KEY, email text, age integer);
       INSERT INTO "${source}" VALUES (1, 'old@example.com', 70)`,
    );
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const { BridgeWatchService } =
      await import('../../src/bridges/bridge-watch.service');
    const watch = app.ctx.get(BridgeWatchService);
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-xf-${dest}`,
        source: {
          kind: 'table',
          connectionId: pg,
          table: source,
          // what the builder's filter editor writes: a NUMBER for a numeric column
          filters: [
            { column: 'age', operator: 'gte', value: 18 },
            { column: 'email', operator: 'notNull' },
          ],
        },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: pgDest,
              table: dest,
              keyColumns: ['id'],
              mapping: ['id', 'email', 'band'].map((c) => ({
                source: c,
                target: c,
              })),
              createMissingTable: true,
            },
          ],
        },
        transform: {
          columns: [
            {
              kind: 'mask',
              column: 'email',
              mode: 'partial',
              keepStart: 1,
              keepEnd: 4,
            },
            { kind: 'set', column: 'band', template: 'age {{age}}' },
          ],
        },
        trigger: {
          kind: 'watch',
          strategy: { strategy: 'increment', column: 'id' },
          pollIntervalMs: 1000,
          startFrom: 'now',
        },
      }),
    );
    cleanups.push(() =>
      watch
        .stop(created.id)
        .then(() => undefined)
        .catch(() => undefined),
    );
    await watch.start(created.id);
    await src(
      `INSERT INTO "${source}" VALUES (2, 'ada@example.com', 36), (3, 'kid@example.com', 9), (4, NULL, 40), (5, 'grace@example.com', 18)`,
    );
    await waitFor('the two that match', async () =>
      (await destRows('postgres_dest', dest)).length >= 2 ? true : null,
    );
    // one more poll's worth of time: nothing else may turn up
    await new Promise((r) => setTimeout(r, 1500));
    const rows = (await destRows('postgres_dest', dest)).sort(
      (a, b) => Number(a.id) - Number(b.id),
    );
    expect(rows.map((r) => [Number(r.id), r.email, r.band])).toEqual([
      [2, 'a**********.com', 'age 36'],
      [5, 'g************.com', 'age 18'],
    ]);
  });
});

/** ~13 KB that does not compress, so Postgres stores it out of line (TOAST) */
const BIG = `(SELECT string_agg(md5(g::text), '') FROM generate_series(1, 400) g)`;

describe('a column Postgres does not resend', () => {
  it('is read back when a computed column needs it, instead of being computed from nothing', async () => {
    const source = uniqueTable('xf_toast');
    const dest = uniqueTable('xf_toast_dst');
    await src(
      `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text, body text)`,
    );
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const id = await bridge({
      source,
      destConn: pgDest,
      dest,
      columns: [
        { kind: 'mask', column: 'body', mode: 'hash' },
        { kind: 'set', column: 'sig', template: '{{name}}/{{body}}' },
      ],
      mapping: ['id', 'name', 'body', 'sig'],
      trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
    });
    await app.cdc.start(id);
    await src(`INSERT INTO "${source}" VALUES (1, 'first', ${BIG})`);
    const body = String(
      (await src(`SELECT body FROM "${source}" WHERE id = 1`)).rows[0]!.body,
    );
    expect(body.length).toBeGreaterThan(10_000);
    const find = async () => (await destRows('postgres_dest', dest))[0];
    await waitFor('the insert', async () =>
      (await find())?.sig === `first/${sha(body)}` ? true : null,
    );

    // `body` is not touched, so the change arrives WITHOUT it
    await src(`UPDATE "${source}" SET name = 'second' WHERE id = 1`);
    await waitFor('the update', async () =>
      (await find())?.name === 'second' ? true : null,
    );
    const row = await find();
    expect(row!.sig).toBe(`second/${sha(body)}`);
    expect(row!.body).toBe(sha(body));
  });
});

describe('a hashed key, live', () => {
  it('still finds its row on an update and on a delete', async () => {
    const source = uniqueTable('xf_live');
    const dest = uniqueTable('xf_live_dst');
    await src(`CREATE TABLE "${source}" (email text PRIMARY KEY, name text)`);
    cleanups.push(() =>
      src(`DROP TABLE IF EXISTS "${source}" CASCADE`).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const id = await bridge({
      source,
      destConn: pgDest,
      dest,
      keyColumns: ['email'],
      columns: [
        { kind: 'mask', column: 'email', mode: 'hash', salt: 'pepper' },
        { kind: 'set', column: 'synced_from', template: '{{$table}}' },
      ],
      mapping: ['email', 'name', 'synced_from'],
      trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
    });
    await app.cdc.start(id);
    const key = sha('pepper' + 'ada@example.com');

    await src(
      `INSERT INTO "${source}" VALUES ('ada@example.com', 'Ada'), ('grace@example.com', 'Grace')`,
    );
    await waitFor('two rows', async () =>
      (await destRows('postgres_dest', dest)).length === 2 ? true : null,
    );
    const find = async () =>
      (
        await withAdapter('postgres_dest', (a) =>
          a.query(`SELECT * FROM "${dest}" WHERE email = '${key}'`),
        )
      ).rows[0];
    expect(await find()).toMatchObject({ name: 'Ada', synced_from: source });

    await src(
      `UPDATE "${source}" SET name = 'Ada L.' WHERE email = 'ada@example.com'`,
    );
    await waitFor('the update', async () =>
      (await find())?.name === 'Ada L.' ? true : null,
    );
    // updated in place — not inserted again under some other key
    expect(await destRows('postgres_dest', dest)).toHaveLength(2);

    // the delete arrives with the PLAIN e-mail; the destination only knows the hash
    await src(`DELETE FROM "${source}" WHERE email = 'ada@example.com'`);
    await waitFor('the delete', async () =>
      (await destRows('postgres_dest', dest)).length === 1 ? true : null,
    );
    expect(await find()).toBeUndefined();
    // the plain address never reached the destination at all
    const everything = await withAdapter('postgres_dest', (a) =>
      a.query(`SELECT * FROM "${dest}"`),
    );
    expect(JSON.stringify(everything.rows)).not.toContain('example.com');
  });
});

describe('an HTTP destination', () => {
  it('receives the shaped row, and the delivery record holds the shaped one too', async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received.push(JSON.parse(data));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;

    const source = await customers();
    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-xf-http-${source}`,
        source: {
          kind: 'table',
          connectionId: pg,
          table: source,
          sort: [{ column: 'id', direction: 'asc' }],
        },
        destination: { kind: 'http', url: `http://127.0.0.1:${port}/hook` },
        transform: {
          fields: ['id', 'email', 'card', 'full_name'],
          columns: [
            { kind: 'mask', column: 'email', mode: 'hash' },
            { kind: 'mask', column: 'card', mode: 'redact' },
            {
              kind: 'set',
              column: 'full_name',
              template: '{{first}} {{last}}',
            },
          ],
        },
        trigger: { kind: 'replay' },
      }),
    );
    const job = await replay(created.id);
    expect(received).toEqual([
      {
        id: 1,
        email: sha(' Ada@Example.com '),
        card: '********',
        full_name: 'Ada Lovelace',
      },
      // a NULL stays NULL: there is nothing to hide
      {
        id: 2,
        email: sha('grace@example.com'),
        card: null,
        full_name: 'Grace Hopper',
      },
    ]);
    const recorded = JSON.stringify(
      await app.prisma.bridgeDelivery.findMany({ where: { jobId: job.id } }),
    );
    expect(recorded).not.toContain('4111111111111111');
    expect(recorded).not.toContain('grace@example.com');
  });
});

describe('the dry run', () => {
  it('shows the rows shaped, plans the table for them, and says what could not be cast', async () => {
    const source = await customers();
    const { bridgeDraftPreviewSchema } = await import('@syncle/core');
    const preview = await controller.previewDraft(
      bridgeDraftPreviewSchema.parse({
        bridge: {
          name: 'draft',
          source: {
            kind: 'table',
            connectionId: pg,
            table: source,
            sort: [{ column: 'id', direction: 'asc' }],
          },
          destination: {
            kind: 'database',
            targets: [
              {
                connectionId: pgDest,
                table: uniqueTable('xf_dry'),
                keyColumns: ['id'],
                mapping: ['id', 'card', 'balance', 'full_name'].map((c) => ({
                  source: c,
                  target: c,
                })),
                createMissingTable: true,
              },
            ],
          },
          transform: { columns: TRANSFORMS },
          trigger: { kind: 'replay' },
        },
      }),
    );
    expect(preview.bodies[0]).toEqual({
      id: 1,
      card: '************1111',
      balance: 12.5,
      full_name: 'Ada Lovelace',
    });
    const planned = Object.fromEntries(
      preview.targets[0].plannedColumns.map(
        (c: { name: string; type: string }) => [c.name, c.type.toLowerCase()],
      ),
    );
    expect(planned).toMatchObject({
      card: 'text',
      balance: 'double precision',
      full_name: 'text',
    });
    expect(preview.warnings.join('\n')).toMatch(
      /cast balance: "n\/a" is not a number; written as NULL/,
    );
  });

  it('refuses a transform it does not know, instead of ignoring it', async () => {
    const { bridgeInputSchema } = await import('@syncle/core');
    const parsed = bridgeInputSchema.safeParse({
      name: 'x',
      source: { kind: 'table', connectionId: pg, table: 't' },
      destination: { kind: 'http', url: 'https://example.test' },
      transform: {
        columns: [{ kind: 'eval', column: 'c', code: 'process.exit()' }],
      },
      trigger: { kind: 'replay' },
    });
    expect(parsed.success).toBe(false);
  });
});
