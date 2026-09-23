/**
 * `GET /api/events`: the stream the page listens to instead of asking every
 * few seconds. over real HTTP, with the real guard in front of it, against the
 * real metadata store — and from a second API process, whose writes have to
 * be heard on a stream opened on the first.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@syncle/core';
import { applyTestEnv } from './env';
import { uniqueTable, waitFor, withAdapter } from './harness';
import { bootstrapApp, connectionFor, type AppHandle } from './app-harness';

applyTestEnv();

let app: any;
let base: string;
let prisma: any;
let handle: AppHandle;
let cookie: string;
let other: AppHandle | null = null;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module');
  const { configureApp } = await import('../../src/configure-app');
  const { AuthService } = await import('../../src/auth/auth.service');
  const { PrismaService } = await import('../../src/common/prisma.service');
  const { ConnectionStoreService } =
    await import('../../src/connections/connection-store.service');
  const { BridgeStoreService } =
    await import('../../src/bridges/bridge-store.service');
  const { BridgeCdcService } =
    await import('../../src/bridges/bridge-cdc.service');
  const { InstanceService } = await import('../../src/common/instance.service');
  app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  prisma = app.get(PrismaService);
  handle = {
    ctx: app,
    connections: app.get(ConnectionStoreService),
    bridges: app.get(BridgeStoreService),
    cdc: app.get(BridgeCdcService),
    prisma,
  };
  // the leader runs the replays
  const instance = app.get(InstanceService);
  await waitFor('leadership', async () => (instance.isLeader() ? true : null), {
    timeoutMs: 20_000,
  });
  // a fresh instance: the one account is made through the setup, which signs it in
  await prisma.appUser.deleteMany({});
  const auth = app.get(AuthService);
  await auth.onModuleInit();
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'root',
      password: 'Correct-Horse-9',
      setupToken: (auth as { setupToken: string }).setupToken,
    }),
  });
  expect(setup.status).toBe(201);
  cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]!;
}, 120_000);

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => undefined);
  await other?.ctx.close().catch(() => undefined);
  await prisma?.appUser.deleteMany({}).catch(() => undefined);
  await app?.close().catch(() => undefined);
});

/** an open stream, read as it comes: `until` resolves with the first event that fits */
async function listen(headers: Record<string, string> = { cookie }) {
  const res = await fetch(`${base}/api/events`, { headers });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const events: LiveEvent[] = [];
  const raw: string[] = [];
  let buffer = '';
  let waiting: Array<{
    fits: (e: LiveEvent) => boolean;
    resolve: (e: LiveEvent) => void;
  }> = [];
  const pump = async () => {
    if (!reader) return;
    for (;;) {
      const { value, done } = await reader
        .read()
        .catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        raw.push(chunk);
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!data) continue;
        let event: LiveEvent;
        try {
          event = JSON.parse(data) as LiveEvent;
        } catch {
          continue;
        }
        events.push(event);
        const still: typeof waiting = [];
        for (const w of waiting) {
          if (w.fits(event)) w.resolve(event);
          else still.push(w);
        }
        waiting = still;
      }
    }
  };
  void pump();
  return {
    res,
    events,
    raw,
    until: (
      fits: (e: LiveEvent) => boolean,
      timeoutMs = 15_000,
    ): Promise<LiveEvent> => {
      const seen = events.find(fits);
      if (seen) return Promise.resolve(seen);
      return new Promise<LiveEvent>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `no such event within ${timeoutMs} ms; heard ${JSON.stringify(events)}`,
              ),
            ),
          timeoutMs,
        );
        waiting.push({
          fits,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    close: () => reader?.cancel().catch(() => undefined),
  };
}

const call = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { cookie },
) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('the stream', () => {
  it('is for the signed in (or a key): nobody else', async () => {
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/events`, {
          headers: { cookie: 'syncle_session=forged' },
        })
      ).status,
    ).toBe(401);
  });

  it('is an event stream, not a JSON envelope; it says hello, and how long to wait before coming back', async () => {
    const s = await listen();
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(s.res.headers.get('cache-control')).toMatch(/no-transform/);
    await waitFor('the greeting', async () => (s.raw.length > 0 ? true : null));
    expect(s.raw[0]).toContain('retry: 2000');
    expect(s.raw[0]).not.toContain('"data"');
    s.close();
  });

  it('tells of a workspace, a connection and a setting as they change — each about what it is about', async () => {
    const s = await listen();
    const made = await (
      await call('POST', '/api/workspaces', { name: `it-ev-${Date.now()}` })
    ).json();
    const workspaceId = made.data.id as string;
    cleanups.push(() =>
      prisma.workspace
        .delete({ where: { id: workspaceId } })
        .then(() => undefined),
    );
    const w = await s.until(
      (e) => e.type === 'workspace' && e.id === workspaceId,
    );
    expect(w.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // the event is the raw event: not `{ data: { ... } }` twice over
    expect(Object.keys(w).sort()).toEqual(['at', 'id', 'type']);

    const connectionId = await connectionFor(handle, 'postgres');
    cleanups.push(() =>
      handle.connections.remove(connectionId).catch(() => undefined),
    );
    await s.until((e) => e.type === 'connection' && e.id === connectionId);

    const settings = await (await call('GET', '/api/settings')).json();
    await call('PUT', '/api/settings', {
      ...settings.data,
      maxQueryRows: (settings.data.maxQueryRows ?? 1000) + 1,
    });
    await s.until((e) => e.type === 'settings');
    await call('PUT', '/api/settings', settings.data);
    s.close();
  }, 60_000);

  it('tells of a bridge, its run, and the run’s deliveries — and thins a burst of them', async () => {
    const source = uniqueTable('ev_src');
    const dest = uniqueTable('ev_dst');
    await withAdapter('postgres', (a) =>
      a.query(`CREATE TABLE "${source}" (id integer PRIMARY KEY, name text)`),
    );
    await withAdapter('postgres', (a) =>
      a.query(
        `INSERT INTO "${source}" SELECT g, 'row' FROM generate_series(1, 300) g`,
      ),
    );
    cleanups.push(() =>
      withAdapter('postgres', (a) => a.dropTable(source)).then(() => undefined),
    );
    cleanups.push(() =>
      withAdapter('postgres_dest', (a) => a.dropTable(dest)).catch(
        () => undefined,
      ),
    );
    const from = await connectionFor(handle, 'postgres');
    const to = await connectionFor(handle, 'postgres_dest');
    const { bridgeInputSchema } = await import('@syncle/core');
    const { BridgeJobService } =
      await import('../../src/bridges/bridge-job.service');
    const jobs = app.get(BridgeJobService);

    const s = await listen();
    const bridge = await handle.bridges.create(
      bridgeInputSchema.parse({
        name: `it-ev-${source}`,
        source: { kind: 'table', connectionId: from, table: source },
        destination: {
          kind: 'database',
          targets: [
            {
              connectionId: to,
              table: dest,
              keyColumns: ['id'],
              createMissingTable: true,
            },
          ],
        },
        transform: { template: '{{$row}}' },
        trigger: { kind: 'replay' },
        // 30 deliveries in quick succession
        delivery: { batchSize: 10, pageSize: 100 },
      }),
    );
    cleanups.push(() =>
      handle.bridges.remove(bridge.id).catch(() => undefined),
    );
    await s.until((e) => e.type === 'bridge' && e.bridgeId === bridge.id);

    const started = await jobs.start(bridge.id);
    await s.until(
      (e) =>
        e.type === 'bridge.job' &&
        e.bridgeId === bridge.id &&
        e.jobId === started.id,
    );
    await s.until(
      (e) => e.type === 'bridge.deliveries' && e.jobId === started.id,
    );
    const job = await waitFor(
      'the replay',
      async () => {
        const j = await prisma.bridgeJob.findUnique({
          where: { id: started.id },
        });
        return j && ['completed', 'failed'].includes(j.status) ? j : null;
      },
      { timeoutMs: 60_000 },
    );
    expect(job.status).toBe('completed');
    expect(job.sentCount).toBe(300);
    // the end of the run is told of, too (the stream needs a moment after the row)
    await waitFor('the last word', async () => {
      const heard = s.events.filter(
        (e) => e.type === 'bridge.job' && e.jobId === started.id,
      );
      return heard.length >= 2 ? true : null;
    });
    // thirty deliveries were recorded, and far fewer events said so
    await new Promise((r) => setTimeout(r, 1000));
    const deliveries = s.events.filter(
      (e) => e.type === 'bridge.deliveries' && e.jobId === started.id,
    );
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries.length).toBeLessThan(30);
    s.close();
  }, 120_000);

  it('an API key may listen, like any GET', async () => {
    const minted = await (
      await call('POST', '/api/auth/api-keys', {
        name: 'events',
        scope: 'read',
      })
    ).json();
    const key = minted.data.key as string;
    const s = await listen({ authorization: `Bearer ${key}` });
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    s.close();
    await prisma.apiKey.deleteMany({ where: { name: 'events' } });
  });

  it('what another API process writes is heard on a stream opened here', async () => {
    other = await bootstrapApp({ standby: true });
    const { WorkspaceStoreService } =
      await import('../../src/workspaces/workspace-store.service');
    const s = await listen();
    const made = await other.ctx
      .get(WorkspaceStoreService)
      .create({ name: `it-ev-other-${Date.now()}` });
    cleanups.push(() =>
      prisma.workspace.delete({ where: { id: made.id } }).then(() => undefined),
    );
    const heard = await s.until(
      (e) => e.type === 'workspace' && e.id === made.id,
    );
    expect(heard.type).toBe('workspace');
    s.close();
  }, 60_000);
});
