/**
 * The two judgements the echo guard rests on, without a database: "is the
 * change that was read the write that was remembered?" and "are these two
 * connection records the same place?". (What it does with them — two bridges
 * feeding each other, a chain, a ring — is tested against real databases in
 * test/integration/loop-prevention.itest.ts.)
 */
import { describe, expect, it } from 'vitest';
import { UNCHANGED, withOrigins, type ConnectionConfig } from '@syncle/core';
import {
  EchoGuardService,
  compact,
  matches,
  physicalId,
  tableTag,
} from './echo-guard.service';
import type { ResolvedBridge } from './bridges.types';
import { encodeRows } from './row-codec';

const wrote = (row: Record<string, unknown>) => ({
  op: 'write' as const,
  r: encodeRows([row]),
});
const deleted = (identity: Record<string, unknown>) => ({
  op: 'delete' as const,
  r: encodeRows([identity]),
});

describe('is the change that was read the write that was remembered?', () => {
  it('yes when every column that was written reads the same', () => {
    expect(
      matches(
        wrote({ id: 1, name: 'a' }),
        { op: 'insert', row: { id: 1, name: 'a' } },
        {},
      ),
    ).toBe(true);
    expect(
      matches(
        wrote({ id: 1, name: 'a' }),
        { op: 'update', row: { id: 1, name: 'b' } },
        {},
      ),
    ).toBe(false);
  });

  it('a value is what it IS, not how a driver spells it', () => {
    const kinds = { qty: 'decimal', at: 'timestamptz', ok: 'boolean' } as const;
    const written = wrote({
      id: 1,
      qty: '12.50',
      at: new Date('2026-03-01T10:20:30.123Z'),
      ok: true,
    });
    expect(
      matches(
        written,
        {
          op: 'update',
          row: { id: '1', qty: 12.5, at: '2026-03-01 10:20:30.123+00', ok: 1 },
        },
        kinds,
      ),
    ).toBe(true);
    expect(
      matches(
        written,
        {
          op: 'update',
          row: { id: 1, qty: 12.51, at: '2026-03-01 10:20:30.123+00', ok: 1 },
        },
        kinds,
      ),
    ).toBe(false);
  });

  it('columns the bridge did not write are not its business', () => {
    expect(
      matches(
        wrote({ id: 1, name: 'a' }),
        { op: 'update', row: { id: 1, name: 'a', note: 'only here' } },
        {},
      ),
    ).toBe(true);
  });

  it('a large value PostgreSQL left out of an UPDATE cannot be what differs', () => {
    expect(
      matches(
        wrote({ id: 1, body: 'x'.repeat(5000), name: 'a' }),
        { op: 'update', row: { id: 1, body: UNCHANGED, name: 'a' } },
        {},
      ),
    ).toBe(true);
  });

  it('a written NULL and a column that reads NULL are the same; NULL and a value are not', () => {
    expect(
      matches(
        wrote({ id: 1, name: null }),
        { op: 'update', row: { id: 1, name: null } },
        {},
      ),
    ).toBe(true);
    expect(
      matches(
        wrote({ id: 1, name: null }),
        { op: 'update', row: { id: 1, name: 'somebody typed this' } },
        {},
      ),
    ).toBe(false);
  });

  it('a delete is only ever a delete, and a write only ever a write', () => {
    expect(
      matches(deleted({ id: 1 }), { op: 'delete', row: { id: 1 } }, {}),
    ).toBe(true);
    expect(
      matches(deleted({ id: 1 }), { op: 'update', row: { id: 1 } }, {}),
    ).toBe(false);
    expect(
      matches(wrote({ id: 1 }), { op: 'delete', row: { id: 1 } }, {}),
    ).toBe(false);
    // what a poll finds has no operation: it is a row that is there, so a write
    expect(
      matches(wrote({ id: 1 }), { op: undefined, row: { id: 1 } }, {}),
    ).toBe(true);
  });

  it('a delete found by KEY may carry less than it went by; one found without a key has to carry it all', () => {
    const byEmail = deleted({ email: 'a@example.test' });
    const onlyThePrimaryKey = { op: 'delete' as const, row: { id: 7 } };
    expect(matches(byEmail, onlyThePrimaryKey, {})).toBe(true); // (the key it was filed under already matched)
    expect(matches(byEmail, onlyThePrimaryKey, {}, true)).toBe(false);
    expect(
      matches(
        byEmail,
        { op: 'delete', row: { id: 7, email: 'a@example.test' } },
        {},
        true,
      ),
    ).toBe(true);
    expect(
      matches(
        byEmail,
        { op: 'delete', row: { id: 7, email: 'b@example.test' } },
        {},
        true,
      ),
    ).toBe(false);
  });

  it('without a key, a row that shares NO written column is nobody’s echo', () => {
    expect(matches(wrote({}), { op: 'insert', row: { id: 1 } }, {}, true)).toBe(
      false,
    );
  });

  it('a document or a file in a column is remembered by its digest — and still told apart', () => {
    const text = 'lorem ipsum '.repeat(1000);
    const file = Buffer.alloc(100_000, 7);
    const remembered = compact({
      id: 1,
      body: text,
      file,
      title: 'short values stay as they are',
    });
    expect(JSON.stringify(encodeRows([remembered])).length).toBeLessThan(500);
    expect(remembered.title).toBe('short values stay as they are');

    const entry = { op: 'write' as const, r: encodeRows([remembered]) };
    expect(
      matches(
        entry,
        {
          op: 'update',
          row: {
            id: 1,
            body: text,
            file: Buffer.from(file),
            title: 'short values stay as they are',
          },
        },
        {},
      ),
    ).toBe(true);
    expect(
      matches(
        entry,
        {
          op: 'update',
          row: {
            id: 1,
            body: `${text}!`,
            file,
            title: 'short values stay as they are',
          },
        },
        {},
      ),
    ).toBe(false);
    const other = Buffer.from(file);
    other[99_999] = 8;
    expect(
      matches(
        entry,
        {
          op: 'update',
          row: {
            id: 1,
            body: text,
            file: other,
            title: 'short values stay as they are',
          },
        },
        {},
      ),
    ).toBe(false);
    // a value that is no longer large is not the value that was written
    expect(
      matches(
        entry,
        {
          op: 'update',
          row: {
            id: 1,
            body: 'short',
            file,
            title: 'short values stay as they are',
          },
        },
        {},
      ),
    ).toBe(false);
    // and one PostgreSQL did not send, because the UPDATE did not touch it, cannot differ
    expect(
      matches(
        entry,
        {
          op: 'update',
          row: {
            id: 1,
            body: UNCHANGED,
            file: UNCHANGED,
            title: 'short values stay as they are',
          },
        },
        {},
      ),
    ).toBe(true);
  });

  it('an entry that cannot be read matches nothing', () => {
    expect(
      matches(
        { op: 'write', r: encodeRows([]) },
        { op: 'insert', row: { id: 1 } },
        {},
      ),
    ).toBe(false);
  });
});

describe('are two connection records the same place?', () => {
  const pg = (extra: Partial<ConnectionConfig>): ConnectionConfig =>
    ({
      id: 'x',
      name: 'x',
      engine: 'postgres',
      host: 'db.internal',
      port: 5432,
      database: 'app',
      ...extra,
    }) as ConnectionConfig;

  it('the record’s name, user and password do not matter; server and database do', () => {
    expect(physicalId(pg({ user: 'reader' }))).toBe(
      physicalId(pg({ user: 'writer', name: 'another record' })),
    );
    expect(physicalId(pg({}))).not.toBe(physicalId(pg({ database: 'other' })));
    expect(physicalId(pg({}))).not.toBe(physicalId(pg({ port: 5433 })));
    expect(physicalId(pg({}))).not.toBe(
      physicalId(pg({ host: 'db2.internal' })),
    );
  });

  it('a host is a host however it is capitalised, and this machine under any of its names', () => {
    expect(physicalId(pg({ host: 'DB.Internal' }))).toBe(physicalId(pg({})));
    expect(physicalId(pg({ host: 'localhost' }))).toBe(
      physicalId(pg({ host: '127.0.0.1' })),
    );
    expect(physicalId(pg({ host: '::1' }))).toBe(
      physicalId(pg({ host: 'localhost' })),
    );
  });

  it('a connection string says the same as the fields would', () => {
    expect(
      physicalId(
        pg({
          host: undefined,
          port: undefined,
          database: undefined,
          connectionString:
            'postgresql://u:p@db.internal:5432/app?sslmode=require',
        }),
      ),
    ).toBe(physicalId(pg({})));
  });

  it('the database a bridge names wins over the connection’s default', () => {
    expect(physicalId(pg({}), 'reports')).toBe(
      physicalId(pg({ database: 'reports' })),
    );
  });

  it('the same address behind two different bastions is two different servers', () => {
    const viaA = pg({ host: '10.0.0.5', ssh: { host: 'bastion-a' } as never });
    const viaB = pg({ host: '10.0.0.5', ssh: { host: 'bastion-b' } as never });
    expect(physicalId(viaA)).not.toBe(physicalId(viaB));
    expect(physicalId(viaA)).toBe(
      physicalId(pg({ host: '10.0.0.5', ssh: { host: 'BASTION-A' } as never })),
    );
  });

  it('a Redis database is a number among the connection’s options; none means 0', () => {
    const redis = (options?: Record<string, unknown>): ConnectionConfig =>
      ({
        id: 'r',
        name: 'r',
        engine: 'redis',
        host: 'cache',
        port: 6379,
        options,
      }) as ConnectionConfig;
    expect(physicalId(redis())).toBe(physicalId(redis({ db: 0 })));
    expect(physicalId(redis({ db: 1 }))).not.toBe(physicalId(redis({ db: 0 })));
    expect(physicalId(redis({ db: '1' }))).toBe(physicalId(redis({ db: 1 })));
  });

  it('a SQLite database is its file', () => {
    const lite = (database: string) =>
      ({ id: 's', name: 's', engine: 'sqlite', database }) as ConnectionConfig;
    expect(physicalId(lite('/data/a.db'))).toBe(physicalId(lite('/data/a.db')));
    expect(physicalId(lite('/data/a.db'))).not.toBe(
      physicalId(lite('/data/b.db')),
    );
  });

  it('a table’s tag is short, stable, and says nothing of where the table is', () => {
    const tag = tableTag('postgres://db.internal:5432/app#public.orders');
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(tag).toBe(tableTag('postgres://db.internal:5432/app#public.orders'));
    expect(tag).not.toBe(
      tableTag('postgres://db.internal:5432/app#public.customers'),
    );
  });
});

/* ----- the service, with Redis and the databases replaced by doubles ----- */

/** the few list commands the guard uses, in memory */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  const norm = (list: string[], i: number) =>
    i < 0 ? Math.max(0, list.length + i) : i;
  const trim = (key: string, from: number, to: number) => {
    const list = lists.get(key) ?? [];
    const kept = list.slice(norm(list, from), norm(list, to) + 1);
    if (kept.length > 0) lists.set(key, kept);
    else lists.delete(key);
  };
  const remove = (key: string, value: string, last: boolean) => {
    const list = lists.get(key) ?? [];
    const at = last ? list.lastIndexOf(value) : list.indexOf(value);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) lists.delete(key);
    return at >= 0 ? 1 : 0;
  };
  const api = {
    lists,
    down: false,
    check() {
      if (api.down) throw new Error('ECONNREFUSED');
    },
    on: () => api,
    quit: async () => 'OK',
    lrange: async (key: string) => {
      api.check();
      return [...(lists.get(key) ?? [])];
    },
    ltrim: async (key: string, from: number, to: number) => {
      api.check();
      trim(key, from, to);
    },
    lrem: async (key: string, _count: number, value: string) => {
      api.check();
      return remove(key, value, false);
    },
    lpop: async (key: string) => {
      api.check();
      const list = lists.get(key) ?? [];
      const head = list.shift() ?? null;
      if (list.length === 0) lists.delete(key);
      return head;
    },
    pipeline: () => {
      const queued: Array<() => void> = [];
      const p = {
        rpush: (key: string, value: string) => {
          queued.push(() => lists.set(key, [...(lists.get(key) ?? []), value]));
          return p;
        },
        ltrim: (key: string, from: number, to: number) => {
          queued.push(() => trim(key, from, to));
          return p;
        },
        expire: () => p,
        lrem: (key: string, _count: number, value: string) => {
          queued.push(() => remove(key, value, true));
          return p;
        },
        exec: async () => {
          api.check();
          queued.forEach((run) => run());
          return [];
        },
      };
      return p;
    },
  };
  return api;
}

/** A -> B and B -> A on one server: `forward` writes table b, which `back` reads */
function rig(
  opts: { there?: Array<Record<string, unknown>>; primaryKey?: string[] } = {},
) {
  const bridgeOf = (id: string, from: [string, string], to: [string, string]) =>
    ({
      id,
      name: id,
      enabled: true,
      source: { kind: 'table', connectionId: from[0], table: from[1] },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: to[0],
            table: to[1],
            writeMode: 'upsert',
            keyColumns: ['id'],
            mapping: [],
            createMissingTable: false,
            onDelete: 'delete',
          },
        ],
      },
      trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
    }) as unknown as ResolvedBridge;
  // (two connection records per database, as two people would have made them)
  const forward = bridgeOf('forward', ['conn-a', 'a'], ['conn-b', 'b']);
  const back = bridgeOf('back', ['conn-b2', 'b'], ['conn-a2', 'a']);
  const onward = bridgeOf('onward', ['conn-b2', 'b'], ['conn-c', 'c']);
  const bridges = [forward, back];

  const prisma = {
    bridge: {
      findMany: async () =>
        bridges.map((b) => ({
          id: b.id,
          name: b.name,
          enabled: true,
          sourceJson: JSON.stringify(b.source),
          destinationJson: JSON.stringify(b.destination),
          triggerJson: JSON.stringify(b.trigger),
        })),
    },
    bridgeJob: {
      findMany: async () => bridges.map((b) => ({ bridgeId: b.id })),
    },
  };
  const record = (id: string) => ({
    id,
    name: id,
    engine: 'postgres',
    host: 'db.internal',
    port: 5432,
    database: id.startsWith('conn-a')
      ? 'da'
      : id.startsWith('conn-b')
        ? 'db'
        : 'dc',
  });
  const connections = {
    resolve: async (id: string) => record(id),
    get: async (id: string) => record(id),
  };
  let reads = 0;
  const adapter = {
    getSchema: async () => ({
      database: 'x',
      namespaces: [
        {
          name: 'public',
          tables: ['a', 'b', 'c'].map((name) => ({
            name,
            primaryKey: opts.primaryKey ?? ['id'],
            columns: [
              { name: 'id', dataType: 'integer' },
              { name: 'name', dataType: 'text' },
              { name: 'qty', dataType: 'numeric(10,2)' },
            ],
          })),
        },
      ],
    }),
    browse: async () => {
      reads++;
      return { rows: opts.there ?? [], hasMore: false };
    },
  };
  const pool = {
    withAdapter: async (
      _c: string,
      _d: string | undefined,
      fn: (a: unknown) => unknown,
    ) => fn(adapter),
  };
  const crypto = {
    encrypt: (text: string) => `sealed:${Buffer.from(text).toString('base64')}`,
    decrypt: (text: string) => Buffer.from(text.slice(7), 'base64').toString(),
  };
  const redis = fakeRedis();
  const guard = new EchoGuardService(
    prisma as never,
    connections as never,
    pool as never,
    crypto as never,
  );
  (guard as unknown as { redis: unknown }).redis = redis;
  const targetOf = (b: ResolvedBridge) =>
    b.destination.kind === 'database'
      ? b.destination.targets[0]!
      : (undefined as never);
  return {
    guard,
    redis,
    forward,
    back,
    onward,
    bridges,
    bridgeOf,
    targetOf,
    target: targetOf(forward),
    reads: () => reads,
  };
}

describe('a write, and the change it comes back as', () => {
  it('is recognised by the bridge that reads the table — once — through another connection record', async () => {
    const r = rig();
    const said = await r.guard.announce(
      r.forward,
      r.target,
      [{ id: 1, name: 'a', qty: '12.50' }],
      [{}],
      'upsert',
    );
    expect(said.receipt?.entries).toHaveLength(1);
    // nothing of the row is readable where it is kept
    expect([...r.redis.lists.values()].flat().join()).not.toContain('"a"');

    const echo = await r.guard.recognise(
      r.back,
      { op: 'insert', row: { id: 1, name: 'a', qty: 12.5 } },
      ['id'],
    );
    expect(echo.echo).toBe(true);
    expect(await r.guard.route(r.back, echo)).toBe('drop');
    expect(r.guard.droppedBy('back')).toBe(1);
    // used up: the same row changed by a person afterwards is theirs
    const again = await r.guard.recognise(
      r.back,
      { op: 'update', row: { id: 1, name: 'a', qty: 12.5 } },
      ['id'],
    );
    expect(again.echo).toBe(false);
  });

  it('somebody’s change to the same row is not an echo, and leaves what is remembered in place', async () => {
    const r = rig();
    await r.guard.announce(
      r.forward,
      r.target,
      [{ id: 1, name: 'a' }],
      [{}],
      'upsert',
    );
    const theirs = await r.guard.recognise(
      r.back,
      { op: 'update', row: { id: 1, name: 'typed by a person' } },
      ['id'],
    );
    expect(theirs.echo).toBe(false);
    const ours = await r.guard.recognise(
      r.back,
      { op: 'update', row: { id: 1, name: 'a' } },
      ['id'],
    );
    expect(ours.echo).toBe(true);
  });

  it('a poll that sees only the LAST of several writes uses up the ones before it', async () => {
    const r = rig();
    for (const name of ['v1', 'v2', 'v3'])
      await r.guard.announce(
        r.forward,
        r.target,
        [{ id: 1, name }],
        [{}],
        'upsert',
      );
    const seen = await r.guard.recognise(
      r.back,
      { op: undefined, row: { id: 1, name: 'v3' } },
      ['id'],
    );
    expect(seen.echo).toBe(true);
    expect(r.redis.lists.size).toBe(0);
  });

  it('a chain passes it on, with where it has been; a ring stops where it began', async () => {
    const r = rig();
    await r.guard.announce(
      r.forward,
      r.target,
      [{ id: 1, name: 'a' }],
      [{}],
      'upsert',
    );
    const atB = await r.guard.recognise(
      r.onward,
      { op: 'insert', row: { id: 1, name: 'a' } },
      ['id'],
    );
    expect(atB.echo).toBe(true);
    expect(await r.guard.route(r.onward, atB)).toBe('forward'); // c is not where it has been
    expect(r.guard.droppedBy('onward')).toBe(0);

    // …written to c by `onward`, carrying where it has been; a bridge from c back to a closes the ring
    const closing = r.bridgeOf('closing', ['conn-c', 'c'], ['conn-a2', 'a']);
    r.bridges.push(r.onward, closing);
    r.guard.forget();
    await r.guard.announce(
      r.onward,
      r.targetOf(r.onward),
      [{ id: 1, name: 'a' }],
      [withOrigins({ id: 1, name: 'a' }, atB.origins)],
      'upsert',
    );
    const atC = await r.guard.recognise(
      closing,
      { op: 'insert', row: { id: 1, name: 'a' } },
      ['id'],
    );
    expect(atC.origins).toHaveLength(2); // a and b
    expect(await r.guard.route(closing, atC)).toBe('drop'); // its target is a: where it began
  });

  it('a row written without the table’s primary key is found by what it holds', async () => {
    const r = rig({ primaryKey: ['pk'] });
    await r.guard.announce(
      r.forward,
      { ...r.target, keyColumns: ['name'] },
      [{ name: 'a', qty: 1 }],
      [{}],
      'upsert',
    );
    const other = await r.guard.recognise(
      r.back,
      { op: 'insert', row: { pk: 9, name: 'b', qty: 1 } },
      ['pk'],
    );
    expect(other.echo).toBe(false);
    const it = await r.guard.recognise(
      r.back,
      { op: 'insert', row: { pk: 9, name: 'a', qty: 1 } },
      ['pk'],
    );
    expect(it.echo).toBe(true);
    expect(r.redis.lists.size).toBe(0);
  });

  it('rows that are already exactly that are neither remembered nor to be written; a delete of nothing is not remembered', async () => {
    const r = rig({ there: [{ id: 1, name: 'same', qty: '5.00' }] });
    const said = await r.guard.announce(
      r.forward,
      r.target,
      [
        { id: 1, name: 'same', qty: 5 },
        { id: 2, name: 'new', qty: 1 },
      ],
      [{}, {}],
      'upsert',
    );
    expect([...said.unchanged]).toEqual([0]);
    expect(said.receipt?.entries).toHaveLength(1);

    const gone = await r.guard.announce(
      r.forward,
      r.target,
      [{ id: 1 }, { id: 404 }],
      [{}, {}],
      'delete',
    );
    expect([...gone.unchanged]).toEqual([]); // a delete is always carried out…
    expect(gone.receipt?.entries).toHaveLength(1); // …but only the one that removes something is expected back
  });

  it('what was said is taken back when the write fails', async () => {
    const r = rig();
    const said = await r.guard.announce(
      r.forward,
      r.target,
      [{ id: 1, name: 'a' }],
      [{}],
      'upsert',
    );
    await r.guard.retract(said.receipt);
    expect(r.redis.lists.size).toBe(0);
  });

  it('a table nobody reads costs nothing: no look at the target, nothing kept', async () => {
    const r = rig();
    const said = await r.guard.announce(
      r.forward,
      { ...r.target, table: 'c' },
      [{ id: 1, name: 'a' }],
      [{}],
      'upsert',
    );
    expect(said).toEqual({ receipt: null, unchanged: new Set() });
    expect(r.reads()).toBe(0);
    expect(r.redis.lists.size).toBe(0);
  });

  it('a mirrored TRUNCATE is recognised once', async () => {
    const r = rig();
    await r.guard.announceTruncate(r.forward, r.target, {});
    const first = await r.guard.recogniseTruncate(r.back);
    expect(first.echo).toBe(true);
    expect(await r.guard.route(r.back, first)).toBe('drop');
    expect((await r.guard.recogniseTruncate(r.back)).echo).toBe(false);
  });
});

describe('when Redis is away', () => {
  it('rows that are already right are STILL not written — what ends a loop nobody recognised must not depend on what failed', async () => {
    const r = rig({ there: [{ id: 1, name: 'same' }] });
    r.redis.down = true;
    const said = await r.guard.announce(
      r.forward,
      r.target,
      [
        { id: 1, name: 'same' },
        { id: 2, name: 'new' },
      ],
      [{}, {}],
      'upsert',
    );
    expect(said.receipt).toBeNull();
    expect([...said.unchanged]).toEqual([0]);
  });

  it('a change is delivered as it always was, and nothing throws', async () => {
    const r = rig();
    r.redis.down = true;
    const nothing = { echo: false, origins: [] };
    expect(
      await r.guard.recognise(r.back, { op: 'insert', row: { id: 1 } }, ['id']),
    ).toEqual(nothing);
    expect(await r.guard.recogniseTruncate(r.back)).toEqual(nothing);
    expect(await r.guard.announceTruncate(r.forward, r.target, {})).toBeNull();
    await expect(
      r.guard.retract({ entries: [['k', 'v']] }),
    ).resolves.toBeUndefined();
  });
});

describe('who a bridge is tied to', () => {
  it('names the bridges on both sides of it, and says nothing of one that is tied to nobody', async () => {
    const r = rig();
    expect(await r.guard.status(r.forward)).toEqual({
      guard: true,
      fedBy: [{ bridgeId: 'back', name: 'back' }],
      feeds: [{ bridgeId: 'back', name: 'back' }],
      heldBack: 0,
    });
    const alone = {
      ...r.forward,
      id: 'alone',
      source: { kind: 'table', connectionId: 'conn-c', table: 'c' },
      destination: { kind: 'http', url: 'https://example.test' },
    } as unknown as ResolvedBridge;
    expect(await r.guard.status(alone)).toEqual({
      guard: true,
      fedBy: [],
      feeds: [],
      heldBack: 0,
    });
  });
});
