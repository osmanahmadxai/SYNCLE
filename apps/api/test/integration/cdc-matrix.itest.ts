/**
 * Every source engine to every destination engine, with real data.
 *
 * Syncle's claim is that any supported engine can sit on either end of a
 * bridge. This is that claim, tested: each pair gets a live CDC bridge, rows
 * written to the source, and the destination checked for the actual VALUES —
 * not just a row count, since a mapping that drops or transposes a column would
 * still produce the right count.
 *
 * SQLite is a destination only. It has no change-capture path for external
 * writers: sqlite3_update_hook fires only for writes made through the same
 * in-process connection, and Syncle reads a file another process writes.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapApp,
  connectionFor,
  destCount,
  makeBridge,
  rowsFor,
  shapeOf,
  writeSourceRows,
  type AppHandle,
  type ConnKey,
} from './app-harness';
import { waitFor, withAdapter } from './harness';

/** engines that can drive a bridge */
const SOURCES: ConnKey[] = ['postgres', 'mysql', 'mongodb', 'redis'];
/** engines that can receive one */
const DESTS: ConnKey[] = ['postgres_dest', 'mysql_dest', 'mongodb', 'sqlite', 'redis_dest'];

const ROWS = 200;
const LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  postgres_dest: 'PostgreSQL',
  mysql: 'MySQL',
  mysql_dest: 'MySQL',
  mongodb: 'MongoDB',
  sqlite: 'SQLite',
  redis: 'Redis',
  redis_dest: 'Redis',
};

let app: AppHandle;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
}, 180_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

/** read one row back from a destination, whatever shape it holds */
async function readBack(
  dest: ConnKey,
  table: string,
  id: number,
): Promise<Record<string, unknown> | null> {
  return withAdapter(dest, async (a) => {
    if (shapeOf(dest) === 'kv') {
      const res = await a.query(`GET ${id}`);
      const row = res.rows[0] as { reply?: unknown } | undefined;
      const value = row?.reply;
      return value === undefined || value === null || value === '' ? null : { value };
    }
    const res = await a.browse({ table, limit: 1000, offset: 0 });
    return (
      (res.rows as Array<Record<string, unknown>>).find(
        (r) => Number(r.id) === id,
      ) ?? null
    );
  });
}

for (const source of SOURCES) {
  describe(`${LABEL[source]} as a source`, () => {
    for (const dest of DESTS) {
      it(`syncs to ${LABEL[dest]}`, async () => {
        // a redis destination counts keys, so start from an empty database
        if (shapeOf(dest) === 'kv') {
          await withAdapter(dest, (a) => a.query('FLUSHDB'));
        }

        const srcConn = await connectionFor(app, source);
        const dstConn = await connectionFor(app, dest);
        const s = await makeBridge(app, {
          sourceEngine: source,
          destEngine: dest,
          sourceConnId: srcConn,
          destConnId: dstConn,
          cleanups,
        });

        await writeSourceRows(source, s.sourceTable, rowsFor(source, ROWS));

        await waitFor(
          `${ROWS} rows ${LABEL[source]} -> ${LABEL[dest]}`,
          async () => ((await destCount(dest, s.destTable)) === ROWS ? true : null),
          { timeoutMs: 120_000, intervalMs: 200 },
        );

        // the count alone would pass even if the mapping transposed columns,
        // so check a value actually arrived intact
        const first = await readBack(dest, s.destTable, 1);
        expect(first, `row 1 missing in ${LABEL[dest]}`).toBeTruthy();
        const carried = shapeOf(dest) === 'kv' ? first?.value : first?.name;
        expect(String(carried)).toBe('row-0');

        const last = await readBack(dest, s.destTable, ROWS);
        const carriedLast = shapeOf(dest) === 'kv' ? last?.value : last?.name;
        expect(String(carriedLast)).toBe(`row-${ROWS - 1}`);

        // and, while the bridge is still listening: verify agrees that the copy is the source
        // — or says plainly that this kind of destination cannot be asked
        const { BridgesController } = await import('../../src/bridges/bridges.controller');
        const controller = app.ctx.get(BridgesController);
        const started = await controller.startVerification(s.bridgeId, { mode: 'verify', deleteExtra: false });
        const v = await waitFor(`verification ${LABEL[source]} -> ${LABEL[dest]}`, async () => {
          const now = await controller.verification(s.bridgeId, started.id);
          return ['completed', 'failed', 'canceled'].includes(now.status) ? now : null;
        });
        expect({ status: v.status, error: v.error }).toEqual({ status: 'completed', error: null });
        const [t] = v.targets;
        if (shapeOf(dest) === 'kv') {
          expect(t!.unsupported).toMatch(/cannot be asked for rows by key/);
        } else if (shapeOf(source) === 'kv') {
          // this Redis database is the one Syncle's own queues and other tests' keys live in, and a
          // bridge that follows changes "from now" never copied those: they ARE missing, and verify
          // is right to say so. what it must not say is that a key this bridge delivered is different
          expect({ unsupported: t!.unsupported, different: t!.samples.different }).toEqual({ unsupported: null, different: [] });
          expect(t!.checked).toBeGreaterThanOrEqual(ROWS);
          expect(t!.samples.missing.map((k) => String(k[0])).filter((k) => /^\d+$/.test(k) && Number(k) <= ROWS)).toEqual([]);
        } else {
          expect({ unsupported: t!.unsupported, checked: t!.checked, samples: t!.samples, notes: t!.notes }).toEqual({
            unsupported: null,
            checked: ROWS,
            samples: { missing: [], different: [], extra: [] },
            notes: [],
          });
          expect(v.inSync).toBe(true);
        }

        await app.cdc.stop(s.bridgeId).catch(() => undefined);
        await app.cdc.cleanup(s.bridgeId).catch(() => undefined);
      }, 180_000);
    }
  });
}

describe('SQLite as a source', () => {
  it('reports CDC as unsupported rather than pretending', async () => {
    // steering people to a watch bridge is the correct behaviour here, and it
    // should be stated by the readiness probe rather than failing at runtime
    const conn = await connectionFor(app, 'sqlite');
    const readiness = await app.cdc.readiness({
      connectionId: conn,
      table: 'anything',
    });
    expect(readiness.supported).toBe(false);
    expect(readiness.instructions.join(' ')).toMatch(/watch|poll/i);
  });
});
