/**
 * Changing the master key, against the real metadata store: every kind of
 * stored secret is written under key A, the application is started again with
 * key B (and A as the previous key), and then with B alone.
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { applyTestEnv } from './env';
import { uniqueTable, waitFor, withAdapter } from './harness';

applyTestEnv();

const KEY_A = process.env.SYNCLE_MASTER_KEY!;
const KEY_B = randomBytes(32).toString('base64');
const made: {
  connection?: string;
  bridge?: string;
  channel?: string;
  source?: string;
} = {};

/** the application, started the way a process with this environment would start */
async function boot(env: { current: string; previous?: string }) {
  vi.resetModules();
  process.env.SYNCLE_MASTER_KEY = env.current;
  process.env.SYNCLE_MASTER_KEY_PREVIOUS = env.previous ?? '';
  const { bootstrapApp } = await import('./app-harness');
  return bootstrapApp();
}

afterAll(async () => {
  // what this made is under ANOTHER key than every other test's: none of it may stay
  process.env.SYNCLE_MASTER_KEY = KEY_B;
  process.env.SYNCLE_MASTER_KEY_PREVIOUS = KEY_A;
  vi.resetModules();
  const { bootstrapApp } = await import('./app-harness');
  const app = await bootstrapApp();
  try {
    if (made.bridge)
      await app.prisma.bridge.deleteMany({ where: { id: made.bridge } });
    if (made.channel)
      await app.prisma.alertChannel.deleteMany({ where: { id: made.channel } });
    if (made.connection)
      await app.prisma.connection.deleteMany({
        where: { id: made.connection },
      });
  } finally {
    await app.ctx.close().catch(() => undefined);
    // …and whatever ELSE is in this store goes back under key A, also when the test
    // stopped half-way: every test after this one runs with key A
    process.env.SYNCLE_MASTER_KEY = KEY_A;
    process.env.SYNCLE_MASTER_KEY_PREVIOUS = KEY_B;
    vi.resetModules();
    const back = await (await import('./app-harness')).bootstrapApp();
    const { KeyRotationService } =
      await import('../../src/common/key-rotation.service');
    await back.ctx
      .get(KeyRotationService)
      .rotate()
      .catch(() => undefined);
    await back.ctx.close().catch(() => undefined);
    process.env.SYNCLE_MASTER_KEY_PREVIOUS = '';
    if (made.source)
      await withAdapter('postgres', (a) => a.dropTable(made.source!)).catch(
        () => undefined,
      );
  }
});

describe('changing the master key', () => {
  it('nothing is unreadable at any point, everything ends up under the new key, and the old one can then go', async () => {
    /* ----- under key A: one of every kind of secret ----- */
    const first = await boot({ current: KEY_A });
    const { AlertChannelStore } =
      await import('../../src/alerts/alert-channel.store');
    const { BridgeJobService } =
      await import('../../src/bridges/bridge-job.service');
    const { bridgeInputSchema } = await import('@syncle/core');
    const source = uniqueTable('kr_src');
    made.source = source;
    await withAdapter('postgres', (a) =>
      a.query(
        `CREATE TABLE "${source}" (id integer PRIMARY KEY, name text); INSERT INTO "${source}" VALUES (1, 'a')`,
      ),
    );
    const connection = await first.connections.create({
      name: `it-kr-${source}`,
      engine: 'postgres',
      host: '127.0.0.1',
      port: 55432,
      user: 'syncle',
      password: 'syncle',
      database: 'syncle_test',
      ssh: {
        host: 'bastion.example.com',
        port: 22,
        user: 'tunnel',
        authMethod: 'password',
        password: 'ssh-secret',
      },
    });
    made.connection = connection.id;
    const bridge = await first.bridges.create(
      bridgeInputSchema.parse({
        name: `it-kr-${source}`,
        source: { kind: 'table', connectionId: connection.id, table: source },
        destination: {
          kind: 'http',
          url: 'https://example.com/hook',
          auth: { type: 'bearer', token: 'webhook-secret-token' },
        },
        transform: { template: '{{$row}}' },
      }),
    );
    made.bridge = bridge.id;
    // a job keeps the bridge as it was — with the secret still encrypted, INSIDE its snapshot
    const job = await first.ctx.get(BridgeJobService).prepare(bridge.id);
    const channel = await first.ctx.get(AlertChannelStore).create({
      kind: 'webhook',
      name: `it-kr-${source}`,
      enabled: false,
      events: ['bridge.failed'],
      url: 'https://example.com/alerts',
      secret: 'signing-secret',
    });
    made.channel = channel.id;
    const before = {
      connection: await first.prisma.connection.findUnique({
        where: { id: connection.id },
      }),
      bridge: await first.prisma.bridge.findUnique({
        where: { id: bridge.id },
      }),
      job: await first.prisma.bridgeJob.findUnique({ where: { id: job.id } }),
    };
    await first.ctx.close();

    /* ----- started with key B, and A as the previous key ----- */
    const second = await boot({ current: KEY_B, previous: KEY_A });
    const { KeyRotationService } =
      await import('../../src/common/key-rotation.service');
    const rotation = second.ctx.get(KeyRotationService);
    // it ran at start. (other tests' rows are in this store too, under key A: they were moved as well — and are
    // moved back below, because those tests run with key A)
    const report = await waitFor('the rotation at start', async () =>
      rotation.status().reencrypted > 0 ? rotation.status() : null,
    );
    expect(report.previousKeys).toBe(1);
    expect(report.reencrypted).toBeGreaterThanOrEqual(4);
    expect(report.unreadable).toBe(0);
    // every ciphertext is a new one
    const after = {
      connection: await second.prisma.connection.findUnique({
        where: { id: connection.id },
      }),
      bridge: await second.prisma.bridge.findUnique({
        where: { id: bridge.id },
      }),
      job: await second.prisma.bridgeJob.findUnique({ where: { id: job.id } }),
    };
    expect(after.connection.passwordEnc).not.toBe(
      before.connection.passwordEnc,
    );
    expect(after.connection.sshSecretsEnc).not.toBe(
      before.connection.sshSecretsEnc,
    );
    expect(after.bridge.authEnc).not.toBe(before.bridge.authEnc);
    expect(JSON.parse(after.job.configSnapshotJson).authEnc).not.toBe(
      JSON.parse(before.job.configSnapshotJson).authEnc,
    );
    // …and nothing else about the snapshot moved
    expect({
      ...JSON.parse(after.job.configSnapshotJson),
      authEnc: null,
    }).toEqual({ ...JSON.parse(before.job.configSnapshotJson), authEnc: null });
    // a second pass has nothing left to do
    expect(await rotation.rotate()).toMatchObject({
      reencrypted: 0,
      unreadable: 0,
    });
    await second.ctx.close();

    /* ----- started with key B ALONE: nothing depends on A any more ----- */
    const third = await boot({ current: KEY_B });
    const resolved = await third.connections.resolve(connection.id);
    expect(resolved.password).toBe('syncle');
    expect(resolved.ssh?.password).toBe('ssh-secret');
    const live = await third.bridges.resolve(bridge.id);
    expect(live.destination).toMatchObject({
      auth: { type: 'bearer', token: 'webhook-secret-token' },
    });
    const snapshot = third.bridges.resolveSnapshot(
      (await third.prisma.bridgeJob.findUnique({ where: { id: job.id } }))
        .configSnapshotJson,
      bridge.id,
    );
    expect(snapshot.destination).toMatchObject({
      auth: { token: 'webhook-secret-token' },
    });
    const { AlertChannelStore: Store3 } =
      await import('../../src/alerts/alert-channel.store');
    expect(
      JSON.stringify(await third.ctx.get(Store3).resolve(channel.id)),
    ).toContain('signing-secret');
    await third.ctx.close();

    /* ----- and with the OLD key alone it is gone: the key is what protects it ----- */
    const fourth = await boot({ current: KEY_A });
    await expect(fourth.connections.resolve(connection.id)).rejects.toThrow();
    await fourth.ctx.close();

    /* ----- back, for the tests that come after this one (they run with key A) ----- */
    const back = await boot({ current: KEY_A, previous: KEY_B });
    const { KeyRotationService: Rotation5 } =
      await import('../../src/common/key-rotation.service');
    await waitFor('the way back', async () =>
      back.ctx.get(Rotation5).status().reencrypted > 0 ? true : null,
    );
    expect((await back.connections.resolve(connection.id)).password).toBe(
      'syncle',
    );
    await back.ctx.close();
  }, 240_000);
});
