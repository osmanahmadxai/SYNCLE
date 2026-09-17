/**
 * Change streams through an SSH tunnel, against a real SSH server.
 *
 * Providers open their own connections to the source — a replication
 * connection, a binlog client, a change stream, a subscriber — and they used to
 * dial the connection's host as written, ignoring its tunnel. So the workbench
 * and replays (which go through the adapter pool, which tunnels) worked on a
 * connection behind a bastion, and CDC on the same connection could not.
 *
 * The databases here are given names that do not resolve
 * (`pg.behind-bastion.test`), and only the SSH server below knows where they
 * really are. A provider that dials the host itself fails with ENOTFOUND; the
 * only way a row can arrive is through the tunnel.
 */
import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import net from 'node:net';
import { Server as SshServer, type Connection } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import { bootstrapApp, destRows, type AppHandle } from './app-harness';

/** where the unresolvable names really live */
const BEHIND: Record<string, { host: string; port: number }> = {
  'pg.behind-bastion.test:5432': { host: '127.0.0.1', port: 55432 },
  'mysql.behind-bastion.test:3306': { host: '127.0.0.1', port: 53306 },
  'mongo.behind-bastion.test:27017': { host: '127.0.0.1', port: 57017 },
  'redis.behind-bastion.test:6379': { host: '127.0.0.1', port: 56379 },
};

let app: AppHandle;
let ssh: SshServer;
let sshPort: number;
/** forwards opened, by the name that was asked for */
const forwards = new Map<string, number>();
const sessions = new Set<Connection>();
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  ssh = new SshServer({ hostKeys: [privateKey] }, (client) => {
    sessions.add(client);
    client.on('close', () => sessions.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (
        ctx.method === 'password' &&
        ctx.username === 'tunnel' &&
        ctx.password === 'through-here'
      )
        ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const name = `${info.destIP}:${info.destPort}`;
        const real = BEHIND[name];
        if (!real) return reject();
        forwards.set(name, (forwards.get(name) ?? 0) + 1);
        const upstream = net.connect(real.port, real.host);
        upstream.once('error', () => reject());
        upstream.once('connect', () => {
          const channel = accept();
          channel.pipe(upstream).pipe(channel);
          channel.on('close', () => upstream.destroy());
          upstream.on('close', () => channel.close());
          upstream.on('error', () => channel.close());
        });
      });
    });
  });
  await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve));
  sshPort = (ssh.address() as net.AddressInfo).port;
  app = await bootstrapApp();
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
  for (const s of sessions) s.end();
  await new Promise<void>((resolve) => ssh.close(() => resolve()));
});

/** a connection whose database can only be reached through the bastion */
async function tunnelled(
  engine: 'postgres' | 'mysql' | 'mongodb' | 'redis',
  extra: Record<string, unknown> = {},
): Promise<string> {
  const at = {
    postgres: {
      host: 'pg.behind-bastion.test',
      port: 5432,
      user: 'syncle',
      password: 'syncle',
      database: 'syncle_test',
    },
    mysql: {
      host: 'mysql.behind-bastion.test',
      port: 3306,
      user: 'root',
      password: 'syncle',
      database: 'syncle_test',
    },
    mongodb: {
      host: 'mongo.behind-bastion.test',
      port: 27017,
      database: 'syncle_test',
    },
    redis: { host: 'redis.behind-bastion.test', port: 6379 },
  }[engine];
  const conn = await app.connections.create({
    name: `it-tunnel-${engine}-${Math.random().toString(36).slice(2, 8)}`,
    engine,
    ...at,
    ...extra,
    ssh: {
      enabled: true,
      host: '127.0.0.1',
      port: sshPort,
      username: 'tunnel',
      authMethod: 'password',
      password: 'through-here',
    },
  });
  return conn.id;
}

/** a plain (untunnelled) Postgres destination, in its own database */
async function destination(): Promise<string> {
  const conn = await app.connections.create({
    name: `it-tunnel-dest-${Math.random().toString(36).slice(2, 8)}`,
    engine: 'postgres',
    host: '127.0.0.1',
    port: 55432,
    user: 'syncle',
    password: 'syncle',
    database: 'syncle_dest',
  });
  return conn.id;
}

async function bridge(opts: {
  sourceConn: string;
  table: string;
  mapping?: Array<{ source: string; target: string }>;
}): Promise<{ bridgeId: string; dest: string }> {
  const dest = uniqueTable('tun_dst');
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
      () => undefined,
    ),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const created = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `it-tunnel-${opts.table}`,
      source: {
        kind: 'table',
        connectionId: opts.sourceConn,
        table: opts.table,
      },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: await destination(),
            table: dest,
            keyColumns: ['id'],
            mapping: opts.mapping ?? [],
            createMissingTable: true,
          },
        ],
      },
      transform: {},
      trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(created.id).catch(() => undefined);
    await app.cdc.cleanup(created.id).catch(() => undefined);
  });
  return { bridgeId: created.id, dest };
}

const ids = async (dest: string): Promise<number[]> =>
  (await destRows('postgres_dest', dest))
    .map((r) => Number(r.id))
    .sort((a, b) => a - b);

describe('PostgreSQL behind a bastion', () => {
  it('streams through the tunnel — the host itself cannot even be resolved', async () => {
    const table = uniqueTable('tun_pg');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY, name text)`),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) =>
        a.query(`DROP TABLE IF EXISTS "${table}"`),
      ).then(() => undefined),
    );
    const b = await bridge({ sourceConn: await tunnelled('postgres'), table });

    const before = forwards.get('pg.behind-bastion.test:5432') ?? 0;
    await app.cdc.start(b.bridgeId);
    await withAdapter('postgres', (a) =>
      a.query(`INSERT INTO "${table}" VALUES (1, 'through the tunnel')`),
    );
    await waitFor('row 1', async () =>
      (await ids(b.dest)).includes(1) ? true : null,
    );
    // the adapter pool's forward AND the replication connection's own
    expect(
      (forwards.get('pg.behind-bastion.test:5432') ?? 0) - before,
    ).toBeGreaterThanOrEqual(2);
  });

  it('pins the bastion’s host key the first time a stream uses it', async () => {
    const table = uniqueTable('tun_pin');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY)`),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) =>
        a.query(`DROP TABLE IF EXISTS "${table}"`),
      ).then(() => undefined),
    );
    const conn = await tunnelled('postgres');
    const b = await bridge({ sourceConn: conn, table });
    await app.cdc.start(b.bridgeId);
    const saved = await app.connections.resolve(conn);
    expect(saved.ssh.hostKey).toMatch(/^SHA256:/);
  });

  it('gets a new tunnel when the SSH connection drops, and loses nothing', async () => {
    const table = uniqueTable('tun_drop');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY, name text)`),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) =>
        a.query(`DROP TABLE IF EXISTS "${table}"`),
      ).then(() => undefined),
    );
    const b = await bridge({ sourceConn: await tunnelled('postgres'), table });
    await app.cdc.start(b.bridgeId);
    await withAdapter('postgres', (a) =>
      a.query(`INSERT INTO "${table}" VALUES (1, 'before')`),
    );
    await waitFor('row 1', async () =>
      (await ids(b.dest)).includes(1) ? true : null,
    );

    // the bastion goes away: every SSH session ends underneath the stream
    for (const s of [...sessions]) s.end();
    await withAdapter('postgres', (a) =>
      a.query(`INSERT INTO "${table}" VALUES (2, 'while the tunnel was down')`),
    );

    await waitFor(
      'row 2, through a new tunnel',
      async () => ((await ids(b.dest)).includes(2) ? true : null),
      {
        timeoutMs: 60_000,
      },
    );
    await withAdapter('postgres', (a) =>
      a.query(`INSERT INTO "${table}" VALUES (3, 'after')`),
    );
    await waitFor('row 3', async () =>
      (await ids(b.dest)).includes(3) ? true : null,
    );
    expect(await ids(b.dest)).toEqual([1, 2, 3]);
    const job = await app.prisma.bridgeJob.findFirstOrThrow({
      where: { bridgeId: b.bridgeId },
    });
    expect(job.status).toBe('running');
  });

  it('closes its tunnel when the stream stops', async () => {
    const table = uniqueTable('tun_stop');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY)`),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) =>
        a.query(`DROP TABLE IF EXISTS "${table}"`),
      ).then(() => undefined),
    );
    const b = await bridge({ sourceConn: await tunnelled('postgres'), table });
    await app.cdc.start(b.bridgeId);
    const stream = (app.cdc as any).streams.get(b.bridgeId);
    expect(stream.route.tunnel).toBeDefined();
    const port = stream.route.tunnel.localPort as number;

    await app.cdc.stop(b.bridgeId);
    // nothing listens on the tunnel's local end any more
    await expect(
      new Promise((resolve, reject) => {
        const probe = net.connect(port, '127.0.0.1');
        probe.once('connect', () => {
          probe.destroy();
          resolve('still open');
        });
        probe.once('error', reject);
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('says what went wrong at the SSH level when the bastion refuses', async () => {
    const table = uniqueTable('tun_bad');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${table}" (id integer PRIMARY KEY)`),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) =>
        a.query(`DROP TABLE IF EXISTS "${table}"`),
      ).then(() => undefined),
    );
    // a host the bastion does not forward to
    const conn = await tunnelled('postgres', {
      host: 'nowhere.behind-bastion.test',
    });
    const b = await bridge({ sourceConn: conn, table });
    await expect(app.cdc.start(b.bridgeId)).rejects.toThrow();
    expect((app.cdc as any).streams.has(b.bridgeId)).toBe(false);
  });
});

describe('the other engines behind a bastion', () => {
  it('MySQL: the binlog client goes through the tunnel', async () => {
    const table = uniqueTable('tun_my');
    await withAdapter('mysql', (a) =>
      a.query(
        `CREATE TABLE \`${table}\` (id int PRIMARY KEY, name varchar(40))`,
      ),
    );
    cleanups.push(() =>
      withAdapter('mysql', (a) =>
        a.query(`DROP TABLE IF EXISTS \`${table}\``),
      ).then(() => undefined),
    );
    const b = await bridge({ sourceConn: await tunnelled('mysql'), table });
    await app.cdc.start(b.bridgeId);
    await withAdapter('mysql', (a) =>
      a.query(`INSERT INTO \`${table}\` VALUES (1, 'binlog')`),
    );
    await waitFor('row 1', async () =>
      (await ids(b.dest)).includes(1) ? true : null,
    );
    expect(
      forwards.get('mysql.behind-bastion.test:3306') ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it('MongoDB: talks only to the tunnelled address, not to the members the replica set names', async () => {
    const collection = uniqueTable('tun_mongo');
    await withAdapter('mongodb', (a) =>
      a.createTable({ table: collection, columns: [] }),
    ).catch(() => undefined);
    cleanups.push(() =>
      withAdapter('mongodb', (a) => a.dropTable(collection)).then(
        () => undefined,
      ),
    );
    const b = await bridge({
      sourceConn: await tunnelled('mongodb'),
      table: collection,
      mapping: [
        { source: 'id', target: 'id' },
        { source: 'name', target: 'name' },
      ],
    });
    const ready = await app.cdc.readiness({
      connectionId: (await app.bridges.get(b.bridgeId)).source.connectionId,
      table: collection,
    });
    expect(ready.ready).toBe(true);
    await app.cdc.start(b.bridgeId);
    await withAdapter('mongodb', (a) =>
      a.insertRow({
        table: collection,
        values: { id: 1, name: 'change stream' },
      }),
    );
    await waitFor('row 1', async () =>
      (await ids(b.dest)).includes(1) ? true : null,
    );
    expect(
      forwards.get('mongo.behind-bastion.test:27017') ?? 0,
    ).toBeGreaterThanOrEqual(1);
  });

  it('Redis: the readiness probe and the subscriber both go through the tunnel', async () => {
    const conn = await tunnelled('redis');
    const prefix = uniqueTable('tun_redis');
    const ready = await app.cdc.readiness({ connectionId: conn, table: '*' });
    expect(
      ready.checks.find((c: { label: string }) => c.label.startsWith('reach')),
    ).toBeUndefined();
    expect(ready.ready).toBe(true);

    const dest = uniqueTable('tun_dst');
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
        () => undefined,
      ),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const created = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-tunnel-${prefix}`,
        source: {
          kind: 'table',
          connectionId: conn,
          table: '*',
          filters: [{ column: 'key', operator: 'eq', value: `${prefix}:*` }],
        },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: await destination(),
              table: dest,
              keyColumns: ['id'],
              mapping: [
                { source: 'key', target: 'id' },
                { source: 'value', target: 'name' },
              ],
              createMissingTable: true,
            },
          ],
        },
        transform: {},
        trigger: { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(created.id).catch(() => undefined);
      await app.cdc.cleanup(created.id).catch(() => undefined);
    });
    await app.cdc.start(created.id);
    await withAdapter('redis', (a) => a.query(`SET ${prefix}:1 hello`));
    cleanups.push(() =>
      withAdapter('redis', (a) => a.query(`DEL ${prefix}:1`)).then(
        () => undefined,
      ),
    );
    await waitFor('the key', async () => {
      const rows = await destRows('postgres_dest', dest);
      return rows.some((r) => r.id === `${prefix}:1` && r.name === 'hello')
        ? true
        : null;
    });
    expect(
      forwards.get('redis.behind-bastion.test:6379') ?? 0,
    ).toBeGreaterThanOrEqual(2);
  });
});
