/**
 * Alerts, end to end: a real bridge really fails, and a real HTTP receiver is
 * really told — signed, once, with the secrets of the channel never coming back
 * out of the API.
 */
import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALERT_SECRET_SENTINEL } from '@syncle/core';
import { uniqueTable, waitFor, withAdapter } from './harness';
import { bootstrapApp, connectionFor, type AppHandle } from './app-harness';

let app: AppHandle;
let alerts: any;
let controller: any;
let jobs: any;
let pg: string;
let pgDest: string;
const cleanups: Array<() => Promise<void>> = [];

interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  raw: string;
  body: Record<string, any>;
}
const received: Received[] = [];
let receiver: http.Server;
let receiverUrl: string;
/** what the receiver answers with; a test can make it refuse */
let answer = 200;

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        headers: req.headers,
        raw,
        body: raw ? JSON.parse(raw) : {},
      });
      res.statusCode = answer;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  app = await bootstrapApp();
  const { AlertsService } = await import('../../src/alerts/alerts.service');
  const { AlertsController } =
    await import('../../src/alerts/alerts.controller');
  const { BridgeJobService } =
    await import('../../src/bridges/bridge-job.service');
  alerts = app.ctx.get(AlertsService);
  controller = app.ctx.get(AlertsController);
  jobs = app.ctx.get(BridgeJobService);
  pg = await connectionFor(app, 'postgres');
  pgDest = await connectionFor(app, 'postgres_dest');
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await app?.prisma.alertChannel.deleteMany({}).catch(() => undefined);
  await app?.ctx.close().catch(() => undefined);
  await new Promise((r) => receiver.close(r));
});

const src = (sql: string) => withAdapter('postgres', (a) => a.query(sql));
const dst = (sql: string) => withAdapter('postgres_dest', (a) => a.query(sql));

async function channel(
  path: string,
  events: string[],
  extra: Record<string, unknown> = {},
) {
  const created = await controller.create({
    kind: 'webhook',
    name: `it ${path.slice(1)}`,
    enabled: true,
    events,
    url: `${receiverUrl}${path}?token=url-secret`,
    secret: 'signing-secret',
    headers: { 'X-Api-Key': 'header-secret' },
    ...extra,
  });
  cleanups.push(() => controller.remove(created.id).catch(() => undefined));
  return created;
}

/** a Postgres -> Postgres bridge whose destination refuses the name POISON */
async function bridge(
  trigger: Record<string, unknown>,
  onError: 'abort' | 'continue',
) {
  const source = uniqueTable('al_src');
  const dest = uniqueTable('al_dst');
  await src(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`);
  await dst(
    `CREATE TABLE "${dest}" (id integer PRIMARY KEY, name text, CONSTRAINT "${dest}_ok" CHECK (name <> 'POISON'))`,
  );
  cleanups.push(() =>
    withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
  );
  cleanups.push(() =>
    withAdapter('postgres_dest', (a) => a.dropTable(dest)).then(
      () => undefined,
    ),
  );
  const { bridgeInputSchema } = await import('@syncle/core');
  const created = await app.bridges.create(
    bridgeInputSchema.parse({
      name: `alerts ${source}`,
      source: { kind: 'table', connectionId: pg, table: source },
      destination: {
        kind: 'database',
        targets: [
          {
            connectionId: pgDest,
            table: dest,
            keyColumns: ['id'],
            mapping: [],
            createMissingTable: false,
          },
        ],
      },
      transform: { template: '{{$row}}' },
      delivery: { onError, maxAttempts: 1 },
      trigger,
    }),
  );
  cleanups.push(async () => {
    await app.cdc.stop(created.id).catch(() => undefined);
    await app.cdc.cleanup(created.id).catch(() => undefined);
  });
  return {
    id: created.id as string,
    name: created.name as string,
    source,
    dest,
  };
}

describe('a channel, as the API shows and stores it', () => {
  it('never hands a secret back — and keeps each one when the form sends back what it was shown', async () => {
    const created = await channel('/crud', ['bridge.failed']);
    const shown = JSON.stringify(created);
    for (const secret of [
      'url-secret',
      'signing-secret',
      'header-secret',
      '/crud',
    ])
      expect(shown).not.toContain(secret);
    expect(created).toMatchObject({
      url: `${receiverUrl}/${ALERT_SECRET_SENTINEL}`,
      secret: ALERT_SECRET_SENTINEL,
      headers: { 'X-Api-Key': ALERT_SECRET_SENTINEL },
      lastStatus: null,
    });
    expect(JSON.stringify(await controller.list())).not.toContain(
      'signing-secret',
    );

    // at rest: not readable either
    const row = await app.prisma.alertChannel.findUnique({
      where: { id: created.id },
    });
    expect(row.configEnc).not.toContain('signing-secret');
    expect(row.configEnc).not.toContain('127.0.0.1');

    // the edit form sends everything back as it was shown, with a new name
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      lastStatus: _s,
      lastError: _e,
      lastSentAt: _t,
      ...form
    } = created;
    const updated = await controller.update(created.id, {
      ...form,
      name: 'renamed',
    });
    expect(updated.name).toBe('renamed');

    received.length = 0;
    expect(await controller.test(created.id)).toEqual({
      ok: true,
      detail: 'HTTP 200',
    });
    // …and it still reaches the same place, with the same header, signed with the same secret
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/crud?token=url-secret');
    expect(received[0]!.headers['x-api-key']).toBe('header-secret');
    const expected = `sha256=${createHmac('sha256', 'signing-secret').update(received[0]!.raw).digest('hex')}`;
    expect(received[0]!.headers['x-syncle-signature']).toBe(expected);
    expect(received[0]!.body).toMatchObject({
      app: 'syncle',
      type: 'test',
      severity: 'warning',
    });
    expect(
      (await controller.list()).find((c: any) => c.id === created.id),
    ).toMatchObject({ lastStatus: 'ok', lastError: null });
  });

  it('says why a channel does not work, and remembers it', async () => {
    const created = await channel('/refusing', ['bridge.failed']);
    answer = 500;
    try {
      expect(await controller.test(created.id)).toMatchObject({
        ok: false,
        detail: expect.stringContaining('HTTP 500'),
      });
    } finally {
      answer = 200;
    }
    expect(
      (await controller.list()).find((c: any) => c.id === created.id),
    ).toMatchObject({
      lastStatus: 'failed',
      lastError: expect.stringContaining('HTTP 500'),
    });
    await expect(controller.test('no-such-channel')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('a bridge that stops', () => {
  it('(a replay, on failure: abort) tells the channels that asked — once, saying which bridge and why', async () => {
    await channel('/failed', ['bridge.failed']);
    await channel('/not-interested', ['source.hold']);
    const b = await bridge({ kind: 'replay' }, 'abort');
    await src(
      `INSERT INTO "${b.source}" VALUES (1, 'fine'), (2, 'POISON'), (3, 'never reached')`,
    );
    received.length = 0;

    const started = await jobs.start(b.id);
    await waitFor('the job to fail', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: started.id },
      });
      return j?.status === 'failed' ? j : null;
    });
    await alerts.idle();

    const told = received.filter((r) => r.path.startsWith('/failed'));
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toMatchObject({
      type: 'bridge.failed',
      severity: 'critical',
      title: `Bridge "${b.name}" stopped`,
      bridgeId: b.id,
      bridgeName: b.name,
      jobId: started.id,
    });
    expect(told[0]!.body.message).toMatch(/onError=abort/);
    expect(told[0]!.headers['x-syncle-event']).toBe('bridge.failed');
    expect(received.some((r) => r.path.startsWith('/not-interested'))).toBe(
      false,
    );
  });

  it('(a replay, on failure: continue) finishes — and says that deliveries failed along the way', async () => {
    await channel('/continued', ['bridge.failed']);
    const b = await bridge({ kind: 'replay' }, 'continue');
    await src(
      `INSERT INTO "${b.source}" VALUES (1, 'fine'), (2, 'POISON'), (3, 'fine too')`,
    );
    received.length = 0;
    const started = await jobs.start(b.id);
    await waitFor('the job to finish', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: started.id },
      });
      return j?.status === 'completed' ? j : null;
    });
    await alerts.idle();
    const told = received.filter((r) => r.path.startsWith('/continued'));
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toMatchObject({
      type: 'bridge.failed',
      severity: 'warning',
    });
    expect(told[0]!.body.title).toContain('finished with 1 failed delivery');
  });

  it('a run with nothing wrong, and a bridge somebody stopped, are not news', async () => {
    await channel('/quiet', [
      'bridge.failed',
      'bridge.dead_letters',
      'bridge.position_lost',
      'source.hold',
    ]);
    const b = await bridge({ kind: 'replay' }, 'abort');
    await src(`INSERT INTO "${b.source}" VALUES (1, 'fine')`);
    received.length = 0;
    const started = await jobs.start(b.id);
    await waitFor('the job to finish', async () => {
      const j = await app.prisma.bridgeJob.findUnique({
        where: { id: started.id },
      });
      return j?.status === 'completed' ? j : null;
    });

    const live = await bridge(
      { kind: 'cdc', operations: ['insert'] },
      'continue',
    );
    await app.cdc.start(live.id);
    await app.cdc.stop(live.id);
    await alerts.idle();
    expect(received.filter((r) => r.path.startsWith('/quiet'))).toEqual([]);
  });
});

describe('a live bridge that sets rows aside', () => {
  it('carries on — and says that rows are waiting, which nothing else would', async () => {
    await channel('/parked', ['bridge.dead_letters']);
    const b = await bridge(
      { kind: 'cdc', operations: ['insert', 'update', 'delete'] },
      'continue',
    );
    await app.cdc.start(b.id);
    received.length = 0;
    await src(`INSERT INTO "${b.source}" VALUES (1, 'fine'), (2, 'POISON')`);
    await waitFor('the dead letter', async () =>
      (await app.prisma.bridgeDeadLetter.count({
        where: { bridgeId: b.id, status: 'pending' },
      })) === 1
        ? true
        : null,
    );
    await alerts.idle();
    const told = received.filter((r) => r.path.startsWith('/parked'));
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toMatchObject({
      type: 'bridge.dead_letters',
      severity: 'warning',
      bridgeId: b.id,
    });
    expect(told[0]!.body.title).toBe(
      `1 row was set aside on bridge "${b.name}"`,
    );
    expect(told[0]!.body.message).toContain('First error:');

    // another bad row a moment later is the same news: held back, not sent again
    await src(`INSERT INTO "${b.source}" VALUES (3, 'POISON')`);
    await waitFor('the second dead letter', async () =>
      (await app.prisma.bridgeDeadLetter.count({
        where: { bridgeId: b.id, status: 'pending' },
      })) === 2
        ? true
        : null,
    );
    await alerts.idle();
    expect(received.filter((r) => r.path.startsWith('/parked'))).toHaveLength(
      1,
    );
    // the bridge is still running: that is the point of `continue`
    const job = await app.prisma.bridgeJob.findFirst({
      where: { bridgeId: b.id },
    });
    expect(job.status).toBe('running');
  });
});

describe('a live bridge that loses its place', () => {
  it('says so as what it is — not as one more failure', async () => {
    await channel('/lost', ['bridge.position_lost']);
    await channel('/lost-as-failure', ['bridge.failed']);
    const b = await bridge({ kind: 'cdc', operations: ['insert'] }, 'abort');
    await app.cdc.start(b.id);
    // a bridge that has never delivered anything has no place to lose
    await src(`INSERT INTO "${b.source}" VALUES (1, 'fine')`);
    await waitFor('a position', async () => {
      const j = await app.prisma.bridgeJob.findFirst({
        where: { bridgeId: b.id },
      });
      return j?.cursorJson ? true : null;
    });
    await app.cdc.stop(b.id);
    await src(
      `SELECT pg_drop_replication_slot('syncle_slot_${b.id.replace(/-/g, '')}')`,
    );
    received.length = 0;

    // found at boot, the way a restart after a long night finds it
    await app.prisma.bridgeJob.updateMany({
      where: { bridgeId: b.id },
      data: { status: 'running', finishedAt: null },
    });
    await app.cdc.onModuleInit();
    await alerts.idle();

    const told = received.filter((r) => r.path.startsWith('/lost'));
    expect(told.map((r) => r.path.split('?')[0])).toEqual(['/lost']);
    expect(told[0]!.body).toMatchObject({
      type: 'bridge.position_lost',
      severity: 'critical',
      bridgeId: b.id,
    });
    expect(told[0]!.body.title).toContain('lost its place');
    expect(told[0]!.body.message).toMatch(/continue from now/i);
  });
});
