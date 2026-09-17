/**
 * TLS, against real servers that accept nothing else.
 *
 * The four `*-tls` services in docker-compose.test.yml present a certificate
 * issued to `localhost` / `127.0.0.1` by a throwaway CA (.test-certs/). What is
 * checked is that each mode means what it says on EVERY engine — before this,
 * one checkbox meant four different things — and that every connection a bridge
 * opens is covered, the change streams included:
 *
 *   require      connects without knowing the CA (encrypted, unverified)
 *   verify-ca    needs the right CA; any name on the certificate will do
 *   verify-full  needs the right CA AND the right name
 *
 * MySQL runs with `require_secure_transport`, MongoDB with `requireTLS` and
 * Redis has no plaintext port at all, so a client that quietly skips TLS — which
 * is what MongoDB's adapter and the MySQL binlog stream used to do — fails here
 * rather than passing.
 */
import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdapter } from '@syncle/core/adapters';
import type { ConnectionConfig, DatabaseEngine, TlsConfig } from '@syncle/core';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
} from './app-harness';

const CERTS = resolve(__dirname, '../../../../.test-certs');
const READY = existsSync(resolve(CERTS, 'ca.crt'));
const pem = (name: string): string =>
  readFileSync(resolve(CERTS, name), 'utf8');

const ENDPOINTS: Record<
  'postgres' | 'mysql' | 'mongodb' | 'redis',
  Partial<ConnectionConfig>
> = {
  postgres: {
    port: 55433,
    user: 'syncle',
    password: 'syncle',
    database: 'syncle_test',
  },
  mysql: {
    port: 53307,
    user: 'root',
    password: 'syncle',
    database: 'syncle_test',
  },
  mongodb: {
    port: 57018,
    database: 'syncle_test',
    options: { directConnection: true },
  },
  redis: { port: 56380 },
};
type Engine = keyof typeof ENDPOINTS;
const ENGINES = Object.keys(ENDPOINTS) as Engine[];

function config(
  engine: Engine,
  over: Partial<ConnectionConfig> = {},
): ConnectionConfig {
  const now = new Date().toISOString();
  return {
    id: `tls-${engine}`,
    name: `tls ${engine}`,
    workspaceId: 'it',
    engine: engine as DatabaseEngine,
    host: 'localhost',
    createdAt: now,
    updatedAt: now,
    ...ENDPOINTS[engine],
    ...over,
  };
}

/** the Redis server demands a client certificate; the others do not mind one */
const clientCert = (engine: Engine): Partial<TlsConfig> =>
  engine === 'redis' ? { cert: pem('client.crt'), key: pem('client.key') } : {};

async function ping(cfg: ConnectionConfig): Promise<void> {
  const adapter = createAdapter(cfg);
  try {
    await adapter.connect();
    await adapter.ping();
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

describe.runIf(READY)('TLS modes, engine by engine', () => {
  describe.each(ENGINES)('%s', (engine) => {
    const tls = (
      t: TlsConfig,
      over: Partial<ConnectionConfig> = {},
    ): ConnectionConfig =>
      config(engine, { tls: { ...clientCert(engine), ...t }, ...over });

    it('require: encrypts without being told the CA', async () => {
      await expect(ping(tls({ mode: 'require' }))).resolves.toBeUndefined();
    });

    it('verify-ca: accepts the right CA', async () => {
      await expect(
        ping(tls({ mode: 'verify-ca', ca: pem('ca.crt') })),
      ).resolves.toBeUndefined();
    });

    it('verify-ca: refuses a certificate from a CA it was not given', async () => {
      await expect(
        ping(tls({ mode: 'verify-ca', ca: pem('other-ca.crt') })),
      ).rejects.toThrow();
      // and the system's CA store does not know this private CA either
      await expect(ping(tls({ mode: 'verify-ca' }))).rejects.toThrow();
    });

    it('verify-ca: does not care which name the certificate carries', async () => {
      await expect(
        ping(
          tls({
            mode: 'verify-ca',
            ca: pem('ca.crt'),
            servername: 'some-other-name.example',
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it('verify-full: accepts the host the certificate was issued for, by name and by IP', async () => {
      await expect(
        ping(tls({ mode: 'verify-full', ca: pem('ca.crt') })),
      ).resolves.toBeUndefined();
      await expect(
        ping(
          tls(
            { mode: 'verify-full', ca: pem('ca.crt') },
            { host: '127.0.0.1' },
          ),
        ),
      ).resolves.toBeUndefined();
    });

    it('verify-full: REFUSES a valid certificate issued for a different host', async () => {
      // right CA, wrong server. this is the check that actually authenticates the
      // server — and the one both MySQL clients were unable to make
      await expect(
        ping(
          tls({
            mode: 'verify-full',
            ca: pem('ca.crt'),
            servername: 'db.somewhere-else.example',
          }),
        ),
      ).rejects.toThrow(/TLS|cert|altname|hostname|identity/i);
    });

    it('verify-full: still needs the right CA', async () => {
      await expect(
        ping(tls({ mode: 'verify-full', ca: pem('other-ca.crt') })),
      ).rejects.toThrow();
    });

    it('through an SSH tunnel it verifies the database host, not the tunnel’s 127.0.0.1', async () => {
      // what the tunnel service hands an adapter: host rewritten to loopback,
      // the real name carried beside it
      const tunnelled = (realHost: string): ConnectionConfig =>
        tls(
          { mode: 'verify-full', ca: pem('ca.crt') },
          { host: '127.0.0.1', tlsHostOverride: realHost },
        );
      await expect(ping(tunnelled('localhost'))).resolves.toBeUndefined();
      await expect(ping(tunnelled('db.internal.example'))).rejects.toThrow();
    });
  });

  it('postgres: the session really is encrypted', async () => {
    const adapter = createAdapter(
      config('postgres', { tls: { mode: 'require' } }),
    );
    try {
      await adapter.connect();
      const res = await adapter.query(
        'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
      );
      expect(res.rows[0]!.ssl).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it('mysql: the session really is encrypted', async () => {
    const adapter = createAdapter(
      config('mysql', { tls: { mode: 'require' } }),
    );
    try {
      await adapter.connect();
      const res = await adapter.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      expect(String(res.rows[0]!.Value)).not.toBe('');
    } finally {
      await adapter.close();
    }
  });

  it('redis: a server that demands a client certificate gets one, and refuses without', async () => {
    const base = { mode: 'verify-full' as const, ca: pem('ca.crt') };
    await expect(ping(config('redis', { tls: base }))).rejects.toThrow();
    await expect(
      ping(
        config('redis', {
          tls: { ...base, cert: pem('client.crt'), key: pem('client.key') },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe.runIf(READY)('connections saved under the old on/off switch', () => {
  it('MongoDB: the switch used to do nothing — plaintext, against a TLS-only server', async () => {
    // `ssl: true`, no tls block: exactly what an existing saved connection holds
    await expect(
      ping(config('mongodb', { ssl: true })),
    ).resolves.toBeUndefined();
    // and with the switch off it is refused, which proves the line above used TLS
    await expect(ping(config('mongodb', { ssl: false }))).rejects.toThrow();
  });

  it('Postgres and MySQL keep connecting as they did: encrypted, unverified', async () => {
    await expect(
      ping(config('postgres', { ssl: true })),
    ).resolves.toBeUndefined();
    await expect(ping(config('mysql', { ssl: true }))).resolves.toBeUndefined();
  });

  it('MySQL without TLS is refused by a server that requires it', async () => {
    await expect(ping(config('mysql', { ssl: false }))).rejects.toThrow();
  });

  it('Redis keeps verifying against the system CAs, as `tls: {}` always did', async () => {
    await expect(ping(config('redis', { ssl: true }))).rejects.toThrow();
  });
});

/* ----- the change streams: separate connections, and they were not covered ----- */

describe.runIf(READY)('CDC over TLS', () => {
  let app: AppHandle;
  let dstConn: string;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    app = await bootstrapApp();
    dstConn = await connectionFor(app, 'postgres_dest');
  }, 120_000);

  afterAll(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
    await app?.ctx.close().catch(() => undefined);
  });

  async function sourceConnection(
    engine: 'postgres' | 'mysql',
    tls: TlsConfig,
  ): Promise<string> {
    const c = config(engine, { tls });
    const saved = await app.connections.create({
      name: `it-tls-${engine}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      engine: c.engine,
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
      tls,
    });
    return saved.id;
  }

  async function cdcBridge(engine: 'postgres' | 'mysql', tls: TlsConfig) {
    const src = uniqueTable('tls_src');
    const dst = uniqueTable('tls_dst');
    const admin = createAdapter(config(engine, { tls: { mode: 'require' } }));
    await admin.connect();
    await admin.createTable({
      table: src,
      columns: [
        {
          name: 'id',
          type: engine === 'mysql' ? 'int' : 'integer',
          nullable: false,
          primaryKey: true,
          autoIncrement: false,
        },
        {
          name: 'name',
          type: engine === 'mysql' ? 'varchar(64)' : 'text',
          nullable: true,
          primaryKey: false,
          autoIncrement: false,
        },
      ],
    });
    cleanups.push(async () => {
      await admin.dropTable(src).catch(() => undefined);
      await admin.close().catch(() => undefined);
    });
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dst)).then(
        () => undefined,
        () => undefined,
      ),
    );

    const { bridgeInputSchema } = await import('@syncle/core');
    const bridge = await app.bridges.create(
      bridgeInputSchema.parse({
        name: `it-tls-cdc-${src}`,
        source: {
          kind: 'table',
          connectionId: await sourceConnection(engine, tls),
          table: src,
        },
        destination: {
          kind: 'database',
          targets: [{ connectionId: dstConn, table: dst, keyColumns: ['id'] }],
        },
        transform: {},
        trigger: { kind: 'cdc' },
      }),
    );
    cleanups.push(async () => {
      await app.cdc.stop(bridge.id).catch(() => undefined);
      await app.cdc.cleanup(bridge.id).catch(() => undefined);
    });
    return { bridgeId: bridge.id, src, dst, admin };
  }

  describe.each(['postgres', 'mysql'] as const)('%s', (engine) => {
    it('streams changes over a verified connection', async () => {
      const { bridgeId, src, dst, admin } = await cdcBridge(engine, {
        mode: 'verify-full',
        ca: pem('ca.crt'),
      });
      await app.cdc.start(bridgeId);
      await admin.insertRow({
        table: src,
        values: { id: 1, name: 'over-tls' },
      });
      const rows = await waitFor('the row to cross', async () => {
        const r = await destRows('postgres_dest', dst);
        return r.length === 1 ? r : null;
      });
      expect(rows[0]).toMatchObject({ id: 1, name: 'over-tls' });
    });

    it('does NOT stream from a server whose certificate is for another host', async () => {
      // the Postgres stream hard-coded `rejectUnauthorized: false`, and the MySQL
      // binlog connection was given no TLS options at all, so both used to
      // connect here regardless of what the connection's setting said
      const { bridgeId, src, dst, admin } = await cdcBridge(engine, {
        mode: 'verify-full',
        ca: pem('ca.crt'),
        servername: 'db.somewhere-else.example',
      });
      await app.cdc.start(bridgeId).catch(() => undefined);
      await admin.insertRow({
        table: src,
        values: { id: 1, name: 'must-not-cross' },
      });
      await new Promise((r) => setTimeout(r, 4_000));
      expect(await destRows('postgres_dest', dst)).toEqual([]);
    });
  });
});

describe.skipIf(READY)('TLS integration', () => {
  it('needs the TLS test servers: docker compose -f docker-compose.test.yml up -d', () => {
    throw new Error(
      '.test-certs/ca.crt not found — the `certs` service has not run, so the TLS suite cannot. ' +
        'Start the test stack; this test exists so a missing stack fails loudly instead of skipping.',
    );
  });
});
