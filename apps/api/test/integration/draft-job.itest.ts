/**
 * The plan of a bridge that has not run yet — its draft job — and saving the
 * bridge again.
 *
 * The draft used to be deleted and made again, under a new id, on every save.
 * The page that was open on the bridge (the one that had just saved it) asked
 * once more for the deliveries of the run it knew, which was gone: a 404 in the
 * browser's console every time anybody pressed Save.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTable, waitFor, withAdapter } from './harness';
import { bootstrapApp, connectionFor, type AppHandle } from './app-harness';

let app: AppHandle;
let controller: any;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  app = await bootstrapApp();
  const { BridgesController } =
    await import('../../src/bridges/bridges.controller');
  controller = app.ctx.get(BridgesController);
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
});

const drafts = (bridgeId: string) =>
  app.prisma.bridgeJob.findMany({ where: { bridgeId, status: 'draft' } });

describe('saving a bridge that has a plan', () => {
  it('refreshes the plan where it is: the same run, what it would send brought up to date', async () => {
    const source = uniqueTable('draft_src');
    const target = uniqueTable('draft_dst');
    await withAdapter('postgres', (a) =>
      a.query(
        `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text); INSERT INTO "${source}" VALUES (1, 'a'), (2, 'b'), (3, 'c')`,
      ),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(target)).then(
        () => undefined,
      ),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const input = (extra: Record<string, unknown> = {}) =>
      bridgeInputSchema.parse({
        name: `it-draft-${source}`,
        source: { kind: 'table', connectionId: from, table: source, ...extra },
        destination: {
          kind: 'database',
          targets: [{ connectionId: to, table: target, keyColumns: ['id'] }],
        },
        transform: { template: '{{$row}}' },
        trigger: { kind: 'replay' },
      });
    const from = await connectionFor(app, 'postgres');
    const to = await connectionFor(app, 'postgres_dest');

    const bridge = await controller.create(input());
    cleanups.push(() => controller.remove(bridge.id).then(() => undefined));
    const [first] = await drafts(bridge.id);
    expect(first).toMatchObject({ status: 'draft' });
    expect(JSON.parse(first!.configSnapshotJson).source.filters ?? []).toEqual(
      [],
    );

    // saved again, with a filter: fewer rows to send
    await controller.update(
      bridge.id,
      input({ filters: [{ column: 'id', operator: 'gt', value: 1 }] }),
    );
    const after = await drafts(bridge.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first!.id);
    expect(
      JSON.parse(after[0]!.configSnapshotJson).source.filters,
    ).toHaveLength(1);
    // what the open page asks next is answered, not a 404
    await expect(
      controller.listDeliveries(bridge.id, first!.id),
    ).resolves.toEqual([]);

    // it runs — as that same job — and a run is not turned back into a plan by a later save
    const { BridgeJobService } =
      await import('../../src/bridges/bridge-job.service');
    const started = await app.ctx.get(BridgeJobService).start(bridge.id);
    expect(started.id).toBe(first!.id);
    const done = await waitFor('the run', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: first!.id },
      });
      return j && ['completed', 'failed'].includes(j.status) ? j : null;
    });
    expect(done).toMatchObject({ status: 'completed', sentCount: 2 });

    await controller.update(bridge.id, input());
    expect(await drafts(bridge.id)).toEqual([]);
    expect(
      await app.prisma.bridgeJob.findUnique({ where: { id: first!.id } }),
    ).toMatchObject({ status: 'completed', sentCount: 2 });
  }, 120_000);

  it('more than one plan (left by an older version) becomes one', async () => {
    const source = uniqueTable('draft_src');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${source}" (id integer PRIMARY KEY)`),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    const { bridgeInputSchema } = await import('@syncle/core');
    const dto = bridgeInputSchema.parse({
      name: `it-draft-two-${source}`,
      source: {
        kind: 'table',
        connectionId: await connectionFor(app, 'postgres'),
        table: source,
      },
      destination: { kind: 'http', url: 'https://example.test/hook' },
      transform: { template: '{{$row}}' },
      trigger: { kind: 'replay' },
    });
    const bridge = await controller.create(dto);
    cleanups.push(() => controller.remove(bridge.id).then(() => undefined));
    const [one] = await drafts(bridge.id);
    await app.prisma.bridgeJob.create({
      data: {
        id: `${one!.id.slice(0, -4)}beef`,
        bridgeId: bridge.id,
        status: 'draft',
        configSnapshotJson: one!.configSnapshotJson,
        startedAt: new Date(Date.now() - 60_000),
      },
    });
    expect(await drafts(bridge.id)).toHaveLength(2);

    await controller.update(bridge.id, dto);
    const left = await drafts(bridge.id);
    expect(left.map((d: { id: string }) => d.id)).toEqual([one!.id]); // the newer of the two
  }, 120_000);
});
