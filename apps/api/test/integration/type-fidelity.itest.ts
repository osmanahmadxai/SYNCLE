/**
 * Do values arrive as the values they were? Against real engines, through the
 * real application, by both routes a row can take: a replay (read with the
 * adapter) and CDC (decoded from the change log) — the two produce differently
 * typed JavaScript values for the same column, so each is checked.
 *
 * A destination table is auto-created from the source's shape in every case, so
 * this covers the column types the type map picks AND what the drivers then do
 * with the values.
 *
 * Run it under more than one process time zone (`TZ=UTC`, `TZ=Asia/Kabul`): a
 * wall-clock timestamp that is round-tripped through a JavaScript Date only
 * survives when the process happens to sit in UTC.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  type AppHandle,
  type ConnKey,
} from './app-harness';

let app: AppHandle;
let jobs: any;
const conn: Partial<Record<ConnKey, string>> = {};
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  jobs = app.ctx.get(BridgeJobService);
  for (const key of [
    'postgres',
    'postgres_dest',
    'mysql',
    'mysql_dest',
    'mongodb',
    'sqlite',
  ] as const) {
    conn[key] = await connectionFor(app, key);
  }
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

/* ----- helpers ----- */

type Row = Record<string, unknown>;

/** column name → the type the destination engine reports for it */
async function columnTypes(
  engine: ConnKey,
  table: string,
): Promise<Record<string, string>> {
  return withAdapter(engine, async (a) => {
    const schema = await a.getSchema();
    const t = schema.namespaces
      .flatMap((n) => n.tables)
      .find((x) => x.name === table);
    if (!t) throw new Error(`table ${table} not found on ${engine}`);
    return Object.fromEntries(
      t.columns.map((c) => [
        c.name,
        (c.nativeType ?? c.dataType).toLowerCase(),
      ]),
    );
  });
}

async function readAll(engine: ConnKey, table: string): Promise<Row[]> {
  return withAdapter(engine, async (a) => {
    const res = await a.browse({ table, limit: 1000, offset: 0 });
    return [...res.rows].sort((x, y) => Number(x.id) - Number(y.id));
  });
}

async function makeBridge(opts: {
  source: ConnKey;
  dest: ConnKey;
  srcTable: string;
  trigger: 'replay' | 'cdc';
  keyColumns?: string[];
}): Promise<{ bridgeId: string; dstTable: string }> {
  const dstTable = uniqueTable('tf_dst');
  cleanups.push(() =>
    withAdapter(opts.dest, (a) => a.dropTable(dstTable)).then(
      () => undefined,
      () => undefined,
    ),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const bridge = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-types-${opts.srcTable}-${opts.dest}`,
      source: {
        kind: 'table',
        connectionId: conn[opts.source],
        table: opts.srcTable,
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: conn[opts.dest],
            table: dstTable,
            writeMode: 'upsert',
            keyColumns: opts.keyColumns ?? ['id'],
            createMissingTable: true,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      delivery: { batchSize: 50 },
      trigger:
        opts.trigger === 'cdc'
          ? { kind: 'cdc', operations: ['insert', 'update', 'delete'] }
          : { kind: 'replay' },
    }),
  );
  if (opts.trigger === 'cdc') {
    cleanups.push(async () => {
      await app.cdc.stop(bridge.id).catch(() => undefined);
      await app.cdc.cleanup(bridge.id).catch(() => undefined);
    });
    await app.cdc.start(bridge.id);
  }
  return { bridgeId: bridge.id, dstTable };
}

/** run a replay bridge to completion; fails loudly with the job's own error */
async function replay(bridgeId: string): Promise<void> {
  const started = await jobs.start(bridgeId);
  await waitFor(`replay job ${started.id}`, async () => {
    const j = await app.prisma.bridgeJob.findUnique({
      where: { id: started.id },
    });
    if (!j) return null;
    if (
      j.status === 'failed' ||
      (j.status === 'completed' && j.failedCount > 0)
    ) {
      const bad = await app.prisma.bridgeDelivery.findFirst({
        where: { jobId: j.id, status: 'failed' },
      });
      // the delivery carries the destination's own words; the job only says it stopped
      throw new Error(
        `replay ${j.status}: ${bad?.error ?? j.error ?? 'a delivery failed'}`,
      );
    }
    return j.status === 'completed' ? j : null;
  });
  await expectVerifiedIdentical(bridgeId);
}

/**
 * the other half of every test here: a copy that has just been made IS the
 * source, so verify must say so — for every engine pair and every type these
 * tests move. a difference reported here is a false alarm in the comparison
 * (two drivers spelling one value two ways), which is the thing that would make
 * verify useless: nobody believes the third wrong alarm.
 */
async function expectVerifiedIdentical(bridgeId: string): Promise<void> {
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  const controller = app.ctx.get(BridgesController);
  const started = await controller.startVerification(bridgeId, {
    mode: 'verify',
    deleteExtra: false,
  });
  const v = await waitFor(`verification ${started.id}`, async () => {
    const now = await controller.verification(bridgeId, started.id);
    return ['completed', 'failed', 'canceled'].includes(now.status)
      ? now
      : null;
  });
  expect(v.error).toBeNull();
  expect(v.status).toBe('completed');
  for (const t of v.targets) {
    expect(t.unsupported).toBeNull();
    // (the samples say WHICH column and both readings: that is what a failure here needs to show)
    expect({
      target: t.target,
      missing: t.samples.missing,
      different: t.samples.different,
      extra: t.samples.extra,
    }).toEqual({
      target: t.target,
      missing: [],
      different: [],
      extra: [],
    });
    expect(t.checked).toBeGreaterThan(0);
  }
  expect(v.inSync).toBe(true);
}

/**
 * every column of every row AS TEXT, read inside Postgres so no driver sits
 * between the two sides being compared. long values are reduced to a digest so
 * a mismatch reads as one line rather than seventy thousand characters.
 */
async function pgTextRows(engine: ConnKey, table: string): Promise<Row[]> {
  const cols = Object.keys(await columnTypes(engine, table));
  const select = cols
    .map(
      (c) =>
        `CASE WHEN length("${c}"::text) > 120 THEN 'md5:' || md5("${c}"::text) ELSE "${c}"::text END AS "${c}"`,
    )
    .join(', ');
  const res = await withAdapter(engine, (a) =>
    a.query(`SELECT ${select} FROM "${table}" ORDER BY id`),
  );
  return res.rows;
}

/** loosely normalise a value read back from any engine, for comparison */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return `bytes:${v.toString('hex')}`;
  if (v instanceof Uint8Array) return `bytes:${Buffer.from(v).toString('hex')}`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.parse(JSON.stringify(v));
  return v;
}

/* ----- PostgreSQL as the source ----- */

const PG_DDL = (t: string): string => `
  CREATE TABLE "${t}" (
    id          integer PRIMARY KEY,
    c_bool      boolean,
    c_small     smallint,
    c_big       bigint,
    c_num       numeric(38,10),
    c_real      real,
    c_double    double precision,
    c_varchar   varchar(40),
    c_char      char(3),
    c_text      text,
    c_bytes     bytea,
    c_date      date,
    c_time      time,
    c_ts        timestamp,
    c_tstz      timestamptz,
    c_interval  interval,
    c_json      jsonb,
    c_uuid      uuid,
    c_ints      integer[],
    c_texts     text[]
  )`;

const PG_ROWS = (t: string): string => `
  INSERT INTO "${t}" VALUES
  (1, true, 32767, 9223372036854775807, 1234567890123456789012345678.0123456789,
      1.5, 2.718281828459045, 'héllo wörld ✓', 'abc', repeat('x', 70000),
      '\\x00ff10deadbeef00', '2026-02-28', '23:59:58.123456',
      '2026-03-04 05:06:07.891', '2026-03-04 05:06:07.891+00', '1 day 02:03:04',
      '{"a":{"b":[1,2,{"c":null}]},"s":"x"}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      '{1,2,3}', '{"a","b c","d,e"}'),
  (2, false, -32768, -9223372036854775808, -0.0000000001,
      -0.25, -1e300, '', '   ', '',
      '\\x', '0001-01-01', '00:00:00',
      '1999-12-31 23:59:59', '1999-12-31 23:59:59+04:30', '-3 mons',
      '[]', '00000000-0000-0000-0000-000000000000',
      '{}', '{}'),
  (3, null, null, null, null, null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null)`;

describe('PostgreSQL → *', () => {
  let src: string;

  beforeAll(async () => {
    src = uniqueTable('tf_pg');
    await withAdapter('postgres', async (a) => {
      await a.query(PG_DDL(src));
      await a.query(PG_ROWS(src));
    });
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(src)).then(() => undefined),
    );
  }, 60_000);

  it('→ PostgreSQL recreates every column as exactly the type it was', async () => {
    const { bridgeId, dstTable } = await makeBridge({
      source: 'postgres',
      dest: 'postgres_dest',
      srcTable: src,
      trigger: 'replay',
    });
    await replay(bridgeId);

    const want = await columnTypes('postgres', src);
    const got = await columnTypes('postgres_dest', dstTable);
    expect(got).toEqual(want);
    // spot-check the ones the old map narrowed or mangled
    expect(got).toMatchObject({
      c_num: 'numeric(38,10)',
      c_tstz: 'timestamp with time zone',
      c_ts: 'timestamp without time zone',
      c_bytes: 'bytea',
      c_interval: 'interval',
      c_ints: 'integer[]',
      c_varchar: 'character varying(40)',
    });

    // and the values are exactly what the source holds
    expect(await pgTextRows('postgres_dest', dstTable)).toEqual(
      await pgTextRows('postgres', src),
    );
  });

  it('→ PostgreSQL by CDC lands the same values as a replay does', async () => {
    const cdcSrc = uniqueTable('tf_pgcdc');
    await withAdapter('postgres', (a) => a.query(PG_DDL(cdcSrc)));
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(cdcSrc)).then(() => undefined),
    );
    const { dstTable } = await makeBridge({
      source: 'postgres',
      dest: 'postgres_dest',
      srcTable: cdcSrc,
      trigger: 'cdc',
    });
    await withAdapter('postgres', (a) => a.query(PG_ROWS(cdcSrc)));

    await waitFor('3 rows by CDC', async () => {
      const r = await readAll('postgres_dest', dstTable).catch(() => []);
      return r.length === 3 ? r : null;
    });
    expect(await pgTextRows('postgres_dest', dstTable)).toEqual(
      await pgTextRows('postgres', cdcSrc),
    );
  });

  it('→ MySQL keeps exact numbers, bytes, long text and wall-clock times', async () => {
    const { bridgeId, dstTable } = await makeBridge({
      source: 'postgres',
      dest: 'mysql_dest',
      srcTable: src,
      trigger: 'replay',
    });
    await replay(bridgeId);

    expect(await columnTypes('mysql_dest', dstTable)).toMatchObject({
      c_bool: 'tinyint(1)',
      c_big: 'bigint',
      c_num: 'decimal(38,10)',
      c_varchar: 'varchar(40)',
      c_text: 'longtext',
      c_bytes: 'longblob',
      c_date: 'date',
      c_ts: 'datetime(6)',
      c_tstz: 'datetime(6)',
      c_json: 'json',
      c_uuid: 'char(36)',
      c_ints: 'json',
    });

    const [r1, r2, r3] = await readAll('mysql_dest', dstTable);
    expect(r1).toMatchObject({
      c_big: '9223372036854775807',
      c_num: '1234567890123456789012345678.0123456789',
      c_varchar: 'héllo wörld ✓',
      c_date: '2026-02-28',
      // a wall-clock reading must not move, whatever zone this process is in
      c_ts: '2026-03-04 05:06:07.891000',
      // an instant is stored as its UTC wall-clock time
      c_tstz: '2026-03-04 05:06:07.891000',
      c_uuid: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    });
    expect(String(r1!.c_text)).toHaveLength(70000); // MySQL TEXT would stop at 65,535
    expect(plain(r1!.c_bytes)).toBe('bytes:00ff10deadbeef00');
    expect(plain(r1!.c_json)).toEqual({
      a: { b: [1, 2, { c: null }] },
      s: 'x',
    });
    expect(plain(r1!.c_ints)).toEqual([1, 2, 3]);
    expect(plain(r1!.c_texts)).toEqual(['a', 'b c', 'd,e']);
    expect(Number(r1!.c_bool)).toBe(1);

    expect(r2).toMatchObject({
      c_big: '-9223372036854775808',
      c_num: '-0.0000000001',
      c_ts: '1999-12-31 23:59:59.000000',
      c_tstz: '1999-12-31 19:29:59.000000', // 23:59:59+04:30 as UTC
    });
    expect(plain(r2!.c_bytes)).toBe('bytes:');
    expect(Number(r2!.c_bool)).toBe(0);
    for (const [k, v] of Object.entries(r3!))
      if (k !== 'id') expect(v).toBeNull();
  });

  it('→ SQLite keeps exact numbers and bytes', async () => {
    const { bridgeId, dstTable } = await makeBridge({
      source: 'postgres',
      dest: 'sqlite',
      srcTable: src,
      trigger: 'replay',
    });
    await replay(bridgeId);
    const [r1, r2] = await readAll('sqlite', dstTable);
    // 38 digits cannot survive a float; NUMERIC affinity keeps it as text
    expect(String(r1!.c_num)).toBe('1234567890123456789012345678.0123456789');
    expect(String(r1!.c_big)).toBe('9223372036854775807');
    expect(plain(r1!.c_bytes)).toBe('bytes:00ff10deadbeef00');
    expect(r1!.c_varchar).toBe('héllo wörld ✓');
    expect(JSON.parse(String(r1!.c_json))).toEqual({
      a: { b: [1, 2, { c: null }] },
      s: 'x',
    });
    expect(JSON.parse(String(r1!.c_ints))).toEqual([1, 2, 3]);
    expect(String(r2!.c_num)).toBe('-0.0000000001');
  });

  it('→ MongoDB keeps structure as structure', async () => {
    const { bridgeId, dstTable } = await makeBridge({
      source: 'postgres',
      dest: 'mongodb',
      srcTable: src,
      trigger: 'replay',
    });
    await replay(bridgeId);
    const [r1] = await readAll('mongodb', dstTable);
    expect(plain(r1!.c_json)).toEqual({
      a: { b: [1, 2, { c: null }] },
      s: 'x',
    });
    expect(plain(r1!.c_ints)).toEqual([1, 2, 3]);
    expect(r1!.c_bool).toBe(true);
    expect(String(r1!.c_num)).toBe('1234567890123456789012345678.0123456789');
    expect(plain(r1!.c_bytes)).toBe('bytes:00ff10deadbeef00');
  });
});

/* ----- MySQL as the source ----- */

describe('MySQL → PostgreSQL', () => {
  let src: string;

  const DDL = (t: string): string => `
    CREATE TABLE \`${t}\` (
      id        int PRIMARY KEY,
      c_flag    tinyint(1),
      c_tiny    tinyint,
      c_uint    int unsigned,
      c_ubig    bigint unsigned,
      c_dec     decimal(30,12),
      c_double  double,
      c_varchar varchar(40),
      c_text    longtext,
      c_blob    blob,
      c_date    date,
      c_time    time(6),
      c_dt      datetime(6),
      c_ts      timestamp(6) NULL,
      c_year    year,
      c_json    json,
      c_enum    enum('small','large'),
      c_bit     bit(1)
    )`;
  const ROWS = (t: string): string => `
    INSERT INTO \`${t}\` VALUES
    (1, 1, 127, 4294967295, 18446744073709551615, 123456789012345678.123456789012,
        2.718281828459045, 'héllo wörld ✓', REPEAT('y', 70000), X'00ff10deadbeef00',
        '2026-02-28', '23:59:58.123456', '2026-03-04 05:06:07.891000',
        '2026-03-04 05:06:07.891000', 2026, '{"a":{"b":[1,2]}}', 'large', b'1'),
    (2, 0, -128, 0, 0, -0.000000000001, -1e300, '', '', X'',
        '1000-01-01', '00:00:00', '1000-01-01 00:00:00', '1971-01-01 00:00:00',
        1901, '[]', 'small', b'0'),
    (3, null, null, null, null, null, null, null, null, null, null, null, null,
        null, null, null, null, null)`;

  beforeAll(async () => {
    src = uniqueTable('tf_my');
    await withAdapter('mysql', async (a) => {
      await a.query(DDL(src));
      await a.query(ROWS(src));
    });
    cleanups.push(() =>
      withAdapter('mysql', (a) => a.dropTable(src)).then(() => undefined),
    );
  }, 60_000);

  for (const trigger of ['replay', 'cdc'] as const) {
    it(`by ${trigger}: booleans, unsigned integers, decimals, bytes and wall-clock times`, async () => {
      let table = src;
      if (trigger === 'cdc') {
        table = uniqueTable('tf_mycdc');
        await withAdapter('mysql', (a) => a.query(DDL(table)));
        cleanups.push(() =>
          withAdapter('mysql', (a) => a.dropTable(table)).then(() => undefined),
        );
      }
      const { bridgeId, dstTable } = await makeBridge({
        source: 'mysql',
        dest: 'postgres_dest',
        srcTable: table,
        trigger,
      });
      if (trigger === 'replay') await replay(bridgeId);
      else {
        await withAdapter('mysql', (a) => a.query(ROWS(table)));
        await waitFor('3 rows by CDC', async () => {
          const r = await readAll('postgres_dest', dstTable).catch(() => []);
          return r.length === 3 ? r : null;
        });
      }

      expect(await columnTypes('postgres_dest', dstTable)).toMatchObject({
        c_flag: 'boolean',
        c_tiny: 'smallint',
        c_uint: 'bigint', // 4,294,967,295 does not fit a signed integer
        c_ubig: 'numeric(20,0)', // nor 18,446,744,073,709,551,615 a signed bigint
        c_dec: 'numeric(30,12)',
        c_double: 'double precision',
        c_varchar: 'character varying(40)',
        c_text: 'text',
        c_blob: 'bytea',
        c_date: 'date',
        c_dt: 'timestamp without time zone',
        c_ts: 'timestamp without time zone',
        c_year: 'smallint',
        c_json: 'jsonb',
        c_enum: 'text',
        c_bit: 'boolean',
      });

      // read back as text IN Postgres, so no driver reinterprets anything
      const got = await withAdapter('postgres_dest', (a) =>
        a.query(
          `SELECT id, c_flag::text, c_tiny::text, c_uint::text, c_ubig::text, c_dec::text,
                  c_varchar, length(c_text) AS text_len, encode(c_blob, 'hex') AS blob_hex,
                  c_date::text, c_time::text, c_dt::text, c_ts::text, c_year::text,
                  c_json::text, c_enum, c_bit::text
           FROM "${dstTable}" ORDER BY id`,
        ),
      );
      expect(got.rows[0]).toMatchObject({
        c_flag: 'true',
        c_tiny: '127',
        c_uint: '4294967295',
        c_ubig: '18446744073709551615',
        c_dec: '123456789012345678.123456789012',
        c_varchar: 'héllo wörld ✓',
        blob_hex: '00ff10deadbeef00',
        c_date: '2026-02-28',
        c_time: '23:59:58.123456',
        c_dt: '2026-03-04 05:06:07.891',
        c_ts: '2026-03-04 05:06:07.891',
        c_year: '2026',
        c_enum: 'large',
        c_bit: 'true',
      });
      expect(Number(got.rows[0]!.text_len)).toBe(70000);
      expect(JSON.parse(String(got.rows[0]!.c_json))).toEqual({
        a: { b: [1, 2] },
      });
      expect(got.rows[1]).toMatchObject({
        c_flag: 'false',
        c_tiny: '-128',
        c_uint: '0',
        c_dec: '-0.000000000001',
        blob_hex: '',
        c_date: '1000-01-01',
        c_dt: '1000-01-01 00:00:00',
        c_bit: 'false',
      });
      for (const [k, v] of Object.entries(got.rows[2]!)) {
        if (k !== 'id' && k !== 'text_len') expect(v).toBeNull();
      }
    });
  }
});

/* ----- MongoDB as the source ----- */

describe('MongoDB → PostgreSQL', () => {
  it('ObjectIds, decimals, longs, binaries, dates and nested documents', async () => {
    const { MongoClient, ObjectId, Decimal128, Long, Binary, UUID, Int32 } =
      await import('mongodb');
    const coll = uniqueTable('tf_mongo');
    const client = new MongoClient(
      'mongodb://127.0.0.1:57017/?directConnection=true',
    );
    await client.connect();
    cleanups.push(async () => {
      await client
        .db('syncle_test')
        .collection(coll)
        .drop()
        .catch(() => undefined);
      await client.close();
    });
    const oid = new ObjectId('507f1f77bcf86cd799439011');
    const inner = new ObjectId('65f000000000000000000abc');
    await client
      .db('syncle_test')
      .collection(coll)
      .insertMany([
        {
          _id: oid,
          id: 1,
          // the FIRST document leaves these null: typing must look further
          amount: null,
          seen_at: null,
        },
        {
          _id: new ObjectId('507f1f77bcf86cd799439012'),
          id: 2,
          amount: Decimal128.fromString('12345678901234567890.123456789'),
          big: Long.fromString('9007199254740993'), // not exactly a JS number
          small: new Int32(7),
          ratio: 0.1,
          ok: true,
          seen_at: new Date('2026-03-04T05:06:07.891Z'),
          raw: new Binary(Buffer.from('00ff10', 'hex')),
          uid: new UUID('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'),
          tags: ['a', 'b'],
          owner: { ref: inner, score: Decimal128.fromString('9.5') },
        },
      ]);

    const { bridgeId, dstTable } = await makeBridge({
      source: 'mongodb',
      dest: 'postgres_dest',
      srcTable: coll,
      trigger: 'replay',
      keyColumns: ['_id'],
    });
    await replay(bridgeId);

    expect(await columnTypes('postgres_dest', dstTable)).toMatchObject({
      _id: 'character varying(24)',
      amount: 'numeric', // not "text" because the first document had null
      seen_at: 'timestamp with time zone',
      big: 'bigint',
      ok: 'boolean',
      raw: 'bytea',
      uid: 'uuid',
      tags: 'jsonb',
      owner: 'jsonb',
    });

    const got = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT _id, amount::text, big::text, small::text, ok::text,
                to_char(seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS seen_at,
                encode(raw, 'hex') AS raw_hex, uid::text, tags::text, owner::text
         FROM "${dstTable}" ORDER BY id`,
      ),
    );
    expect(got.rows[0]).toMatchObject({
      _id: '507f1f77bcf86cd799439011',
      amount: null,
    });
    expect(got.rows[1]).toMatchObject({
      _id: '507f1f77bcf86cd799439012',
      amount: '12345678901234567890.123456789',
      big: '9007199254740993',
      small: '7',
      ok: 'true',
      seen_at: '2026-03-04T05:06:07.891',
      raw_hex: '00ff10',
      uid: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    });
    expect(JSON.parse(String(got.rows[1]!.tags))).toEqual(['a', 'b']);
    // a nested ObjectId / Decimal128 must be a value, not the driver's internals
    expect(JSON.parse(String(got.rows[1]!.owner))).toEqual({
      ref: '65f000000000000000000abc',
      score: '9.5',
    });
  });
});

/* ----- the bulk write path ----- */

describe('a batch large enough to take the bulk JSON write path', () => {
  it('lands the same values as the row-by-row parameter path does', async () => {
    // 300 rows is past the adapter's bulk threshold. bytes used to disqualify a
    // batch from this path entirely; bytes, 64-bit integers and wall-clock
    // timestamps all have to survive being carried as JSON
    const src = uniqueTable('tf_bulk');
    await withAdapter('postgres', async (a) => {
      await a.query(`
        CREATE TABLE "${src}" (
          id integer PRIMARY KEY, big bigint, amount numeric(30,10), raw bytea,
          at_wall timestamp, at_instant timestamptz, day date, doc jsonb, tags text[]
        )`);
      await a.query(`
        INSERT INTO "${src}"
        SELECT g,
               9223372036854775000 + g,
               (g::numeric * 1000000007) + 0.0000000001,
               decode(lpad(to_hex(g), 8, '0') || '00ff', 'hex'),
               timestamp '2026-03-04 05:06:07.123456' + (g || ' seconds')::interval,
               timestamptz '2026-03-04 05:06:07.123456+04:30' + (g || ' seconds')::interval,
               date '2026-01-01' + g,
               CASE WHEN g % 3 = 0 THEN '[]'::jsonb
                    WHEN g % 3 = 1 THEN jsonb_build_object('n', g, 'list', jsonb_build_array(g, 'x'))
                    ELSE to_jsonb(g::text) END,
               CASE WHEN g % 2 = 0 THEN ARRAY[]::text[] ELSE ARRAY['a', g::text] END
        FROM generate_series(1, 300) AS g`);
    });
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(src)).then(() => undefined),
    );

    const { bridgeId, dstTable } = await makeBridge({
      source: 'postgres',
      dest: 'postgres_dest',
      srcTable: src,
      trigger: 'replay',
    });
    // one delivery of 300 rows, so the whole batch takes the bulk path at once
    await app.prisma.bridge.update({
      where: { id: bridgeId },
      data: {
        deliveryJson: JSON.stringify({
          ...JSON.parse(
            (await app.prisma.bridge.findUnique({ where: { id: bridgeId } }))
              .deliveryJson,
          ),
          batchSize: 300,
          pageSize: 300,
        }),
      },
    });
    await replay(bridgeId);

    const want = await pgTextRows('postgres', src);
    const got = await pgTextRows('postgres_dest', dstTable);
    expect(got).toHaveLength(300);
    expect(got).toEqual(want);
    // an empty JSON array must still be an ARRAY: bound as a parameter it used
    // to become `{}`, an empty object, with no error
    const empties = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT count(*)::int AS n FROM "${dstTable}" WHERE jsonb_typeof(doc) = 'array'`,
      ),
    );
    expect(empties.rows[0]!.n).toBe(100);
    // and a JSON string of digits is still a STRING, not the number it looks like
    const strings = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT count(*)::int AS n FROM "${dstTable}" WHERE jsonb_typeof(doc) = 'string'`,
      ),
    );
    expect(strings.rows[0]!.n).toBe(100);
  });

  it('a json column holding only scalars survives a small batch too', async () => {
    // no array or object anywhere in the batch, so nothing about the VALUES
    // says "json" — a bare string parameter would be a syntax error, or worse,
    // "123" would arrive as the number 123
    const src = uniqueTable('tf_scalar');
    await withAdapter('postgres', async (a) => {
      await a.query(
        `CREATE TABLE "${src}" (id integer PRIMARY KEY, doc jsonb, plain json)`,
      );
      await a.query(
        `INSERT INTO "${src}" VALUES (1, '"abc"', '"x y"'), (2, '"123"', '7'), (3, 'true', '"true"')`,
      );
    });
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(src)).then(() => undefined),
    );
    const { bridgeId, dstTable } = await makeBridge({
      source: 'postgres',
      dest: 'postgres_dest',
      srcTable: src,
      trigger: 'replay',
    });
    await replay(bridgeId);
    expect(await pgTextRows('postgres_dest', dstTable)).toEqual(
      await pgTextRows('postgres', src),
    );
  });
});

/* ----- SQLite as the source ----- */

describe('SQLite → PostgreSQL', () => {
  it('64-bit integers, text JSON and untyped columns', async () => {
    const src = uniqueTable('tf_lite');
    await withAdapter('sqlite', async (a) => {
      await a.query(
        `CREATE TABLE "${src}" (id INTEGER PRIMARY KEY, big INTEGER, doc JSON, loose, flag BOOLEAN, price DECIMAL(10,2))`,
      );
      await a.query(
        `INSERT INTO "${src}" VALUES
           (1, 9223372036854775807, '{"a":[1,2]}', 'free text', 1, 19.99),
           (2, -9223372036854775808, '[]', 'more', 0, 0.5),
           (3, NULL, NULL, NULL, NULL, NULL)`,
      );
    });
    cleanups.push(() =>
      withAdapter('sqlite', (a) => a.dropTable(src)).then(() => undefined),
    );

    const { bridgeId, dstTable } = await makeBridge({
      source: 'sqlite',
      dest: 'postgres_dest',
      srcTable: src,
      trigger: 'replay',
    });
    await replay(bridgeId);

    expect(await columnTypes('postgres_dest', dstTable)).toMatchObject({
      big: 'bigint',
      doc: 'jsonb',
      loose: 'text', // undeclared: text, not bytea
      flag: 'boolean',
      price: 'numeric(10,2)',
    });
    const got = await withAdapter('postgres_dest', (a) =>
      a.query(
        `SELECT id, big::text, doc::text, jsonb_typeof(doc) AS doc_kind, loose, flag::text, price::text
         FROM "${dstTable}" ORDER BY id`,
      ),
    );
    expect(got.rows[0]).toMatchObject({
      big: '9223372036854775807', // read as a plain number this was …776000
      doc_kind: 'object', // parsed, not stored as a JSON string of JSON
      loose: 'free text',
      flag: 'true',
      price: '19.99',
    });
    expect(got.rows[1]).toMatchObject({
      big: '-9223372036854775808',
      doc_kind: 'array',
      flag: 'false',
      price: '0.50',
    });
  });
});

/* ----- one bridge's shape must never leak into another's ----- */

describe('auto-created tables across several replay bridges in one process', () => {
  it('each destination gets ITS OWN source columns', async () => {
    // a replay resolves its bridge from the job's config snapshot. that used to
    // come back with `id: ''`, so the sink's per-bridge column cache had a
    // single slot: the first bridge replayed decided the columns of every
    // destination table created after it
    const a = uniqueTable('tf_first');
    const b = uniqueTable('tf_second');
    await withAdapter('postgres', async (pg) => {
      await pg.query(
        `CREATE TABLE "${a}" (id integer PRIMARY KEY, alpha text)`,
      );
      await pg.query(`INSERT INTO "${a}" VALUES (1, 'a')`);
      await pg.query(
        `CREATE TABLE "${b}" (id integer PRIMARY KEY, beta numeric(12,4), gamma date)`,
      );
      await pg.query(`INSERT INTO "${b}" VALUES (1, 1.5, '2026-01-02')`);
    });
    cleanups.push(() =>
      withAdapter('postgres', (pg) => pg.dropTable(a)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres', (pg) => pg.dropTable(b)).then(() => undefined),
    );

    const first = await makeBridge({
      source: 'postgres',
      dest: 'postgres_dest',
      srcTable: a,
      trigger: 'replay',
    });
    await replay(first.bridgeId);
    const second = await makeBridge({
      source: 'postgres',
      dest: 'postgres_dest',
      srcTable: b,
      trigger: 'replay',
    });
    await replay(second.bridgeId);

    expect(
      Object.keys(await columnTypes('postgres_dest', first.dstTable)).sort(),
    ).toEqual(['alpha', 'id']);
    expect(await columnTypes('postgres_dest', second.dstTable)).toEqual({
      id: 'integer',
      beta: 'numeric(12,4)',
      gamma: 'date',
    });
    expect(await pgTextRows('postgres_dest', second.dstTable)).toEqual(
      await pgTextRows('postgres', b),
    );
  });
});

/* ----- seeing the table before it is made ----- */

describe('preview', () => {
  it('shows the columns a run would create, warns about what cannot be kept, and creates nothing', async () => {
    const src = uniqueTable('tf_prev');
    await withAdapter('postgres', async (a) => {
      await a.query(
        `CREATE TABLE "${src}" (id uuid PRIMARY KEY, total numeric, placed_at timestamptz, note text)`,
      );
      await a.query(
        `INSERT INTO "${src}" VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1.5, now(), 'x')`,
      );
    });
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(src)).then(() => undefined),
    );
    const { bridgeId, dstTable } = await makeBridge({
      source: 'postgres',
      dest: 'mysql_dest',
      srcTable: src,
      trigger: 'replay',
    });

    const { BridgesController } =
      await import('../../src/bridges/bridges.controller');
    const preview = await app.ctx
      .get(BridgesController)
      .preview(bridgeId, { limit: 1 });

    expect(preview.destinationKind).toBe('database');
    expect(preview.targets![0]).toMatchObject({
      exists: false,
      createMissingTable: true,
    });
    expect(
      preview.targets![0]!.plannedColumns!.map(
        (c) => `${c.name}: ${c.sourceType} -> ${c.type}`,
      ),
    ).toEqual([
      'id: uuid -> CHAR(36)',
      'total: numeric -> DECIMAL(65,30)',
      'placed_at: timestamp with time zone -> DATETIME(6)',
      'note: text -> LONGTEXT',
    ]);
    expect(preview.targets![0]!.plannedColumns![0]).toMatchObject({
      primaryKey: true,
      nullable: false,
    });
    // the two columns MySQL cannot hold faithfully are named; the other two are not
    expect(preview.warnings).toHaveLength(2);
    expect(preview.warnings[0]).toMatch(/total \(numeric → DECIMAL\(65,30\)\)/);
    expect(preview.warnings[1]).toMatch(/placed_at .*UTC/);

    // a preview is read-only
    await expect(columnTypes('mysql_dest', dstTable)).rejects.toThrow(
      /not found/,
    );

    // once the table exists there is nothing left to plan
    await replay(bridgeId);
    const after = await app.ctx
      .get(BridgesController)
      .preview(bridgeId, { limit: 1 });
    expect(after.targets![0]).toMatchObject({ exists: true });
    expect(after.targets![0]!.plannedColumns).toBeUndefined();
    expect(after.warnings).toEqual([]);
  });
});
