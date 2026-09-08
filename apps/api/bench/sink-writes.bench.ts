/**
 * The destination's own write ceiling: how fast rows can be written into each
 * engine when nothing else is in the way.
 *
 * This exists for one reason — to say how much of the achievable throughput the
 * sync pipeline is actually capturing. A sync rate means little on its own; a
 * sync rate next to the destination's ceiling says whether the remaining cost
 * is the database or us.
 */
import 'reflect-metadata';
import { afterAll, describe, it } from 'vitest';
import { uniqueTable, withAdapter } from '../test/integration/harness';
import {
  captureEnvironment,
  makeResult,
  publishSuite,
  resourceDetail,
  ResourceSampler,
  timed,
  type BenchResult,
} from './harness';

const ROWS = 1_000_000;
const CHUNK = 50_000;

const results: BenchResult[] = [];
type Engine = 'postgres' | 'mysql' | 'sqlite' | 'redis';
const created: Array<{ engine: Engine; table: string }> = [];

afterAll(async () => {
  for (const t of created) {
    await withAdapter(t.engine, (a) => a.dropTable(t.table)).catch(() => undefined);
  }
  publishSuite(
    {
      id: 'write-ceiling',
      name: 'Destination write ceiling',
      description:
        'Rows written straight into a destination table, with no change stream ' +
        'involved. This is the fastest the destination can accept them, and the ' +
        'bar the sync figures above are measured against.',
      results,
    },
    await captureEnvironment(),
  );
});

describe.each(['postgres', 'mysql', 'sqlite', 'redis'] as const)(
  'write ceiling — %s',
  (engine) => {
  it(`absorbs ${ROWS.toLocaleString()} rows`, async () => {
    const table = uniqueTable('ceil');
    const types =
      engine === 'mysql'
        ? { int: 'int', text: 'varchar(255)' }
        : engine === 'sqlite'
          ? { int: 'INTEGER', text: 'TEXT' }
          : { int: 'integer', text: 'text' };

    await withAdapter(engine, async (a) => {
      // Redis stores keys, not tables — nothing to create, and the rows below
      // are shaped as key/value rather than id/name
      if (engine !== 'redis') {
        await a.createTable({
          table,
          columns: [
            { name: 'id', type: types.int, nullable: false, primaryKey: true },
            { name: 'name', type: types.text, nullable: true },
          ],
        });
        created.push({ engine, table });
      }

      const sampler = new ResourceSampler();
      sampler.start();
      const { ms } = await timed(async () => {
        for (let start = 0; start < ROWS; start += CHUNK) {
          const size = Math.min(CHUNK, ROWS - start);
          await a.upsertRows!({
            table,
            keyColumns: engine === 'redis' ? ['key'] : ['id'],
            rows: Array.from({ length: size }, (_, i) =>
              engine === 'redis'
                ? { key: `bench:${start + i + 1}`, value: `row-${start + i}` }
                : { id: start + i + 1, name: `row-${start + i}` },
            ),
          });
        }
      });
      const usage = sampler.stop();
      const label = {
        postgres: 'PostgreSQL',
        mysql: 'MySQL',
        sqlite: 'SQLite',
        redis: 'Redis',
      }[engine];
      results.push(
        makeResult(`${label} · upsert`, ROWS, ms, resourceDetail(usage, [engine])),
      );
      console.log(
        `  ✓ ${engine} ceiling: ${ROWS} rows in ${ms}ms (${Math.round(ROWS / (ms / 1000))}/s)`,
      );
      });
    });
  },
);
