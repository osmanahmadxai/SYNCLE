import { describe, expect, it, vi } from 'vitest';
import { eventOf, writeMiddleware, type PrismaWrite } from './write-events';

const write = (
  model: string,
  action: string,
  args: Record<string, unknown>,
  result: unknown = {},
): PrismaWrite => ({ model, action, args, result });

const AT = new Date('2026-09-23T10:00:00.000Z');

describe('which event a write is', () => {
  it('a bridge, by its id', () => {
    expect(
      eventOf(
        write(
          'Bridge',
          'update',
          { where: { id: 'b1' }, data: { name: 'x' } },
          { id: 'b1' },
        ),
        AT,
      ),
    ).toEqual({
      type: 'bridge',
      bridgeId: 'b1',
      at: '2026-09-23T10:00:00.000Z',
    });
  });

  it('a run: its bridge and itself, from the row Prisma answered with', () => {
    expect(
      eventOf(
        write(
          'BridgeJob',
          'update',
          { where: { id: 'j1' }, data: { status: 'running' } },
          { id: 'j1', bridgeId: 'b1', status: 'running' },
        ),
      ),
    ).toMatchObject({ type: 'bridge.job', bridgeId: 'b1', jobId: 'j1' });
  });

  it('…from the `where` when the answer was narrowed, and from the data when it was created', () => {
    expect(
      eventOf(
        write(
          'BridgeJob',
          'update',
          {
            where: { id: 'j1' },
            data: { status: 'x' },
            select: { status: true },
          },
          { status: 'x' },
        ),
      ),
    ).toMatchObject({ type: 'bridge.job', jobId: 'j1' });
    expect(
      eventOf(
        write(
          'BridgeJob',
          'create',
          { data: { id: 'j2', bridgeId: 'b2', status: 'queued' } },
          { id: 'j2', bridgeId: 'b2' },
        ),
      ),
    ).toMatchObject({ bridgeId: 'b2', jobId: 'j2' });
  });

  it('many runs at once (by bridge and status): the bridge, and no run in particular', () => {
    const e = eventOf(
      write(
        'BridgeJob',
        'updateMany',
        {
          where: { bridgeId: 'b1', status: 'running' },
          data: { status: 'failed' },
        },
        { count: 2 },
      ),
    );
    expect(e).toMatchObject({ type: 'bridge.job', bridgeId: 'b1' });
    expect(e?.jobId).toBeUndefined();
  });

  it('a `where` that names several rows names none', () => {
    const e = eventOf(
      write(
        'BridgeDelivery',
        'deleteMany',
        { where: { jobId: { in: ['j1', 'j2'] } } },
        { count: 9 },
      ),
    );
    expect(e).toMatchObject({ type: 'bridge.deliveries' });
    expect(e?.jobId).toBeUndefined();
  });

  it('a delivery, addressed by its (run, sequence) pair', () => {
    expect(
      eventOf(
        write(
          'BridgeDelivery',
          'upsert',
          {
            where: { jobId_sequence: { jobId: 'j1', sequence: 4 } },
            create: {},
            update: {},
          },
          { status: 'success' },
        ),
      ),
    ).toMatchObject({ type: 'bridge.deliveries', jobId: 'j1' });
  });

  it('the rest of the store: one kind each; what nobody watches is nothing', () => {
    expect(
      eventOf(
        write(
          'BridgeVerification',
          'create',
          { data: { bridgeId: 'b1' } },
          { id: 'v', bridgeId: 'b1' },
        ),
      ),
    ).toMatchObject({ type: 'bridge.verification', bridgeId: 'b1' });
    expect(
      eventOf(
        write(
          'BridgeDeadLetter',
          'delete',
          { where: { id: 'd' } },
          { id: 'd', bridgeId: 'b1' },
        ),
      ),
    ).toMatchObject({ type: 'bridge.deadLetters', bridgeId: 'b1' });
    expect(
      eventOf(
        write('Connection', 'update', { where: { id: 'c1' } }, { id: 'c1' }),
      ),
    ).toMatchObject({ type: 'connection', id: 'c1' });
    expect(
      eventOf(
        write('Workspace', 'create', { data: { name: 'w' } }, { id: 'w1' }),
      ),
    ).toMatchObject({ type: 'workspace', id: 'w1' });
    expect(
      eventOf(
        write('AppSetting', 'upsert', { where: { key: 'k' } }, { key: 'k' }),
      ),
    ).toMatchObject({ type: 'settings' });
    expect(
      eventOf(write('AppUser', 'update', { where: { id: 'u' } }, { id: 'u' })),
    ).toMatchObject({ type: 'users' });
    expect(
      eventOf(write('ApiKey', 'create', { data: {} }, { id: 'k' })),
    ).toMatchObject({ type: 'apiKeys' });
    expect(
      eventOf(write('AuditEntry', 'create', { data: {} }, { id: 'a' })),
    ).toMatchObject({ type: 'audit' });
    expect(
      eventOf(
        write('AlertChannel', 'delete', { where: { id: 'ch' } }, { id: 'ch' }),
      ),
    ).toMatchObject({ type: 'alertChannels' });
    expect(
      eventOf(write('CdcSharedMember', 'create', { data: {} }, { id: 'm' })),
    ).toBeNull();
    expect(
      eventOf(
        write('SourceCleanup', 'update', { where: { id: 's' } }, { id: 's' }),
      ),
    ).toBeNull();
  });

  it('an id that is not a string (a number, a filter) is not an id', () => {
    const e = eventOf(
      write(
        'Connection',
        'updateMany',
        { where: { id: { startsWith: 'c' } } },
        { count: 1 },
      ),
    );
    expect(e?.id).toBeUndefined();
  });
});

describe('the middleware', () => {
  const params = (
    model: string | undefined,
    action: string,
    args: Record<string, unknown> = {},
  ) =>
    ({
      model,
      action,
      args,
      dataPath: [],
      runInTransaction: false,
    }) as unknown as Parameters<ReturnType<typeof writeMiddleware>>[0];

  it('passes the write through, and tells the listeners afterwards — with what came back', async () => {
    const heard: unknown[] = [];
    const mw = writeMiddleware([(w) => heard.push(w)]);
    const order: string[] = [];
    const next = vi.fn(async () => {
      order.push('write');
      return { id: 'b1' };
    });
    const result = await mw(
      params('Bridge', 'update', { where: { id: 'b1' } }),
      next as never,
    );
    expect(result).toEqual({ id: 'b1' });
    expect(heard).toEqual([
      {
        model: 'Bridge',
        action: 'update',
        args: { where: { id: 'b1' } },
        result: { id: 'b1' },
      },
    ]);
  });

  it('a read is nobody’s business; nor is a raw statement', async () => {
    const heard: unknown[] = [];
    const mw = writeMiddleware([(w) => heard.push(w)]);
    await mw(params('Bridge', 'findMany'), (async () => []) as never);
    await mw(params(undefined, 'executeRaw'), (async () => 3) as never);
    expect(heard).toEqual([]);
  });

  it('a listener that throws does not fail the write, nor the listeners after it', async () => {
    const heard: unknown[] = [];
    const mw = writeMiddleware([
      () => {
        throw new Error('meh');
      },
      (w) => heard.push(w.model),
    ]);
    await expect(
      mw(params('Workspace', 'create', { data: {} }), (async () => ({
        id: 'w',
      })) as never),
    ).resolves.toEqual({ id: 'w' });
    expect(heard).toEqual(['Workspace']);
  });

  it('a write that fails is not told of', async () => {
    const heard: unknown[] = [];
    const mw = writeMiddleware([(w) => heard.push(w)]);
    await expect(
      mw(params('Bridge', 'delete', { where: { id: 'x' } }), (async () => {
        throw new Error('gone');
      }) as never),
    ).rejects.toThrow('gone');
    expect(heard).toEqual([]);
  });
});
