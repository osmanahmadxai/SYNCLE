/**
 * A polling bridge that follows an `updated_at` column, and a row that is
 * changed more than once.
 *
 * The rows at the cursor's boundary — the most recently changed rows of the
 * table — were remembered by primary key alone. When one of them changed AGAIN,
 * the poll that fetched it took it for a row it had already sent, and then
 * moved the cursor past it: the update was never delivered and nothing would
 * ever bring it back. On a table where the same few rows keep changing (a
 * status, a balance, a counter) that was most updates.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import {
  bootstrapApp,
  connectionFor,
  destRows,
  type AppHandle,
  type ConnKey,
} from './app-harness';

let app: AppHandle;
let controller: any;
let watch: any;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  const { BridgeWatchService } =
    await import('../../src/bridges/bridge-watch.service');
  controller = app.ctx.get(BridgesController);
  watch = app.ctx.get(BridgeWatchService);
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const DDL: Record<string, (t: string) => string> = {
  postgres: (t) =>
    `CREATE TABLE "${t}" (id integer PRIMARY KEY, status text, updated_at timestamptz NOT NULL DEFAULT now())`,
  mysql: (t) =>
    `CREATE TABLE \`${t}\` (id integer PRIMARY KEY, status text, updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6))`,
};
const q = (engine: string, t: string) =>
  engine === 'mysql' ? `\`${t}\`` : `"${t}"`;
const NOW: Record<string, string> = {
  postgres: 'clock_timestamp()',
  mysql: 'CURRENT_TIMESTAMP(6)',
};

describe.each([
  ['postgres', 'postgres_dest', 0],
  ['postgres', 'postgres_dest', 3000],
  ['mysql', 'postgres_dest', 3000],
] as Array<[ConnKey, ConnKey, number]>)(
  '%s → %s, lookback %i ms',
  (source, dest, lookbackMs) => {
    it('every change of a row that keeps changing arrives — and the ones in between too', async () => {
      const src = uniqueTable('wt_src');
      const dst = uniqueTable('wt_dst');
      const run = (sql: string) => withAdapter(source, (a) => a.query(sql));
      await run(DDL[source]!(src));
      await run(
        `INSERT INTO ${q(source, src)} (id, status) VALUES (1, 'new'), (2, 'new'), (3, 'new')`,
      );
      cleanups.push(() =>
        withAdapter(source, (a) => a.dropTable(src)).then(() => undefined),
      );
      cleanups.push(() =>
        withAdapter(dest, (a) => a.dropTable(dst)).then(() => undefined),
      );

      const { bridgeInputSchema } = await import('@syncle/core');
      const bridge = await controller.create(
        bridgeInputSchema.parse({
          name: `it-wt-${src}`,
          source: {
            kind: 'table',
            connectionId: await connectionFor(app, source),
            table: src,
          },
          destination: {
            kind: 'database',
            targets: [
              {
                connectionId: await connectionFor(app, dest),
                table: dst,
                keyColumns: ['id'],
                createMissingTable: true,
              },
            ],
          },
          transform: { template: '{{$row}}' },
          trigger: {
            kind: 'watch',
            strategy: {
              strategy: 'timestamp',
              column: 'updated_at',
              lookbackMs,
            },
            pollIntervalMs: 1000,
            startFrom: 'beginning',
          },
        }),
      );
      cleanups.push(() => controller.remove(bridge.id).then(() => undefined));
      await watch.start(bridge.id);
      const statusOf = async () =>
        Object.fromEntries(
          (await destRows(dest, dst)).map((r) => [Number(r.id), r.status]),
        );
      await waitFor('the first copy', async () =>
        Object.keys(await statusOf()).length === 3 ? true : null,
      );

      // the same row, changed again and again — each time it is the newest row of the table
      for (const status of ['paid', 'shipped', 'delivered']) {
        await run(
          `UPDATE ${q(source, src)} SET status = '${status}', updated_at = ${NOW[source]} WHERE id = 2`,
        );
        await waitFor(
          `"${status}" to arrive`,
          async () => ((await statusOf())[2] === status ? true : null),
          { timeoutMs: 15_000 },
        );
      }
      // twice within one poll: the last one is what the destination ends up with
      await run(
        `UPDATE ${q(source, src)} SET status = 'returned', updated_at = ${NOW[source]} WHERE id = 2`,
      );
      await run(
        `UPDATE ${q(source, src)} SET status = 'refunded', updated_at = ${NOW[source]} WHERE id = 2`,
      );
      await waitFor(
        '"refunded" to arrive',
        async () => ((await statusOf())[2] === 'refunded' ? true : null),
        { timeoutMs: 15_000 },
      );
      // another row in between, then the first one again
      await run(
        `UPDATE ${q(source, src)} SET status = 'paid', updated_at = ${NOW[source]} WHERE id = 3`,
      );
      await run(
        `UPDATE ${q(source, src)} SET status = 'closed', updated_at = ${NOW[source]} WHERE id = 2`,
      );
      await waitFor(
        'both to arrive',
        async () => {
          const now = await statusOf();
          return now[2] === 'closed' && now[3] === 'paid' ? true : null;
        },
        { timeoutMs: 15_000 },
      );
      expect(await statusOf()).toEqual({ 1: 'new', 2: 'closed', 3: 'paid' });

      // and nothing is sent over and over: a quiet table is a quiet bridge
      const job = await app.prisma.bridgeJob.findFirst({
        where: { bridgeId: bridge.id },
      });
      const sent = job.sentCount;
      await new Promise((r) => setTimeout(r, 3500));
      expect(
        (await app.prisma.bridgeJob.findUnique({ where: { id: job.id } }))
          .sentCount,
      ).toBe(sent);
      expect(job.failedCount).toBe(0);
    }, 120_000);
  },
);
