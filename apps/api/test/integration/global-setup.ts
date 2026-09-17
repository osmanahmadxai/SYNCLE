/**
 * Brings the test engines to a usable state before the suite runs.
 *
 * Compose can start MongoDB but cannot initiate a replica set, and change
 * streams do not exist without one — so that happens here, idempotently. Also
 * waits for every engine to accept connections, so a slow container start
 * surfaces as a clear message instead of a pile of connection-refused failures.
 */
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { MongoClient } from 'mongodb';
import { bootstrapDrivers, createAdapter } from '@syncle/core/adapters';
import { TEST_CONNECTIONS } from './harness';
import { META_DB_URL, applyTestEnv } from './env';

const MONGO_DIRECT = 'mongodb://127.0.0.1:57017/?directConnection=true';

async function initReplicaSet(): Promise<void> {
  const client = new MongoClient(MONGO_DIRECT, {
    serverSelectionTimeoutMS: 3_000,
  });
  await client.connect();
  try {
    const admin = client.db('admin');
    try {
      await admin.command({ replSetGetStatus: 1 });
      return; // already initiated
    } catch {
      await admin.command({
        replSetInitiate: {
          _id: 'rs0',
          members: [{ _id: 0, host: '127.0.0.1:57017' }],
        },
      });
    }
    // wait for this node to actually become primary before tests open streams
    for (let i = 0; i < 60; i++) {
      try {
        const st = (await admin.command({ replSetGetStatus: 1 })) as {
          myState?: number;
        };
        if (st.myState === 1) return;
      } catch {
        /* still electing */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('mongo replica set did not reach PRIMARY');
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForEngine(name: string): Promise<void> {
  const conn = TEST_CONNECTIONS[name];
  if (!conn) throw new Error(`unknown engine ${name}`);
  let lastErr: unknown;
  for (let i = 0; i < 60; i++) {
    const adapter = createAdapter(conn);
    try {
      await adapter.connect();
      await adapter.ping();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1_000));
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }
  throw new Error(
    `engine "${name}" never became reachable — is docker-compose.test.yml up? ` +
      `last error: ${(lastErr as Error)?.message}`,
  );
}

/**
 * The app's own metadata store. Created here rather than by compose so the
 * schema is migrated with the real Prisma migrations — the same ones production
 * runs — instead of a hand-written approximation.
 */
async function prepareMetadataDatabase(): Promise<void> {
  const admin = new Client({
    host: '127.0.0.1',
    port: 55432,
    user: 'syncle',
    password: 'syncle',
    database: 'syncle_test',
  });
  await admin.connect();
  try {
    for (const db of ['syncle_meta', 'syncle_dest']) {
      const exists = await admin.query('select 1 from pg_database where datname = $1', [db]);
      if (exists.rowCount === 0) await admin.query(`create database "${db}"`);
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: META_DB_URL },
    stdio: 'pipe',
  });
  await resetLeftovers();
}

/**
 * Start every run from an empty metadata store and a source with no leftover
 * replication slots.
 *
 * Tests create bridges and connections and do not delete them, so the store
 * grew without bound across runs — over a thousand bridges, a few of them
 * still marked `running`, which every app a test boots then tries to resume.
 * And a run that is killed halfway leaves its replication slots behind: they
 * pin WAL on the test server and use up its (deliberately small) slot limit.
 */
async function resetLeftovers(): Promise<void> {
  const meta = new Client({ connectionString: META_DB_URL.split('?')[0] });
  await meta.connect();
  try {
    await meta.query(
      `TRUNCATE bridge_deliveries, bridge_dead_letters, bridge_jobs, bridge_verifications, bridges, connections, source_cleanups, alert_channels, api_keys`,
    );
  } finally {
    await meta.end().catch(() => undefined);
  }

  const source = new Client({
    host: '127.0.0.1',
    port: 55432,
    user: 'syncle',
    password: 'syncle',
    database: 'syncle_test',
  });
  await source.connect();
  try {
    await source.query(
      `select pg_terminate_backend(active_pid) from pg_replication_slots
       where active and (slot_name like 'syncle_slot_%' or slot_name like 'it_fill_%')`,
    );
    const slots = await source.query(
      `select slot_name from pg_replication_slots
       where slot_name like 'syncle_slot_%' or slot_name like 'it_fill_%'`,
    );
    for (const row of slots.rows as Array<{ slot_name: string }>) {
      await source.query('select pg_drop_replication_slot($1)', [row.slot_name]).catch(() => undefined);
    }
    const pubs = await source.query(`select pubname from pg_publication where pubname like 'syncle_pub_%'`);
    for (const row of pubs.rows as Array<{ pubname: string }>) {
      await source.query(`drop publication if exists "${row.pubname}"`).catch(() => undefined);
    }
  } finally {
    await source.end().catch(() => undefined);
  }
}

/** MySQL destinations get their own schema too, for symmetry with Postgres */
async function prepareMysqlDestination(): Promise<void> {
  const { createAdapter } = await import('@syncle/core/adapters');
  const adapter = createAdapter(TEST_CONNECTIONS.mysql!);
  try {
    await adapter.connect();
    await adapter.query('CREATE DATABASE IF NOT EXISTS `syncle_dest`');
  } catch {
    /* the suite fails later and more clearly if this really matters */
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

export async function setup(): Promise<void> {
  applyTestEnv();
  bootstrapDrivers();
  await initReplicaSet();
  // the *_dest entries point at databases this function is about to create,
  // so only the base engines are waited on here
  for (const name of Object.keys(TEST_CONNECTIONS)) {
    if (name.endsWith('_dest')) continue;
    await waitForEngine(name);
  }
  await prepareMetadataDatabase();
  await prepareMysqlDestination();
  // now they exist, confirm they are actually reachable
  for (const name of Object.keys(TEST_CONNECTIONS)) {
    if (name.endsWith('_dest')) await waitForEngine(name);
  }
}
