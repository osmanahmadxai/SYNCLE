/**
 * who did what — with the database replaced by a double: what an entry keeps,
 * what it never keeps, how the pages come, and what pruning takes
 */
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

type Row = {
  id: string;
  at: Date;
  actorType: string;
  actorId: string | null;
  actorName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  detailsJson: string | null;
  ip: string | null;
};

function fakePrisma(seed: Row[] = []) {
  const rows = [...seed];
  let clock = Date.parse('2026-09-23T10:00:00Z');
  return {
    rows,
    fail: false,
    auditEntry: {
      create: async ({ data }: { data: Omit<Row, 'at'> & { at?: Date } }) => {
        if (fakePrisma.fail) throw new Error('database gone');
        const row = {
          ...data,
          at: data.at ?? new Date((clock += 1000)),
        } as Row;
        rows.push(row);
        return row;
      },
      findMany: async ({
        where,
        take,
        orderBy,
      }: {
        where: Record<string, unknown>;
        take?: number;
        orderBy?: unknown;
        select?: unknown;
      }) => {
        let out = rows.filter((r) => {
          for (const [k, v] of Object.entries(where)) {
            if (k === 'OR') {
              const alts = v as Array<Record<string, unknown>>;
              const cursorAt = (alts[0]!.at as { lt: Date }).lt;
              const cursorId = (alts[1]!.id as { lt: string }).lt;
              if (
                !(
                  r.at < cursorAt ||
                  (r.at.getTime() === cursorAt.getTime() && r.id < cursorId)
                )
              )
                return false;
            } else if (k === 'at') {
              if (!(r.at < (v as { lt: Date }).lt)) return false;
            } else if ((r as unknown as Record<string, unknown>)[k] !== v)
              return false;
          }
          return true;
        });
        const desc = Array.isArray(orderBy);
        out.sort((a, b) =>
          desc
            ? b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id)
            : a.at.getTime() - b.at.getTime(),
        );
        if (take) out = out.slice(0, take);
        return out;
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const gone = new Set(where.id.in);
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--)
          if (gone.has(rows[i]!.id)) rows.splice(i, 1);
        return { count: before - rows.length };
      },
    },
  };
}
fakePrisma.fail = false;

const ada = { type: 'user' as const, id: 'u1', name: 'ada' };

describe('an entry', () => {
  it('keeps who, what, to what, from where — and its details as JSON', async () => {
    const prisma = fakePrisma();
    const audit = new AuditService(prisma as never);
    await audit.record({
      actor: ada,
      action: 'bridge.create',
      target: { type: 'bridge', id: 'b1', name: 'orders → warehouse' },
      details: { engine: 'postgres', rows: 3n },
      ip: '10.0.0.7',
    });
    expect(prisma.rows[0]).toMatchObject({
      actorType: 'user',
      actorId: 'u1',
      actorName: 'ada',
      action: 'bridge.create',
      targetType: 'bridge',
      targetId: 'b1',
      targetName: 'orders → warehouse',
      detailsJson: '{"engine":"postgres","rows":"3"}',
      ip: '10.0.0.7',
    });
  });

  it('never keeps a secret, whatever it was called in the details — a flag that says one was set is not a secret', async () => {
    const prisma = fakePrisma();
    const audit = new AuditService(prisma as never);
    await audit.record({
      actor: ada,
      action: 'connection.create',
      details: {
        host: 'db',
        password: 'hunter2',
        apiKey: 'syn_x',
        nested: { token: 't', fine: 1 },
        authorization: 'Bearer x',
        passwordSet: true,
      },
    });
    const kept = JSON.parse(prisma.rows[0]!.detailsJson!) as Record<
      string,
      unknown
    >;
    expect(kept).toEqual({
      host: 'db',
      password: '[redacted]',
      apiKey: '[redacted]',
      nested: { token: '[redacted]', fine: 1 },
      authorization: '[redacted]',
      passwordSet: true,
    });
  });

  it('cuts a name or the details that would not fit, and says so with an ellipsis', async () => {
    const prisma = fakePrisma();
    const audit = new AuditService(prisma as never);
    await audit.record({
      actor: { ...ada, name: 'n'.repeat(500) },
      action: 'x',
      target: { type: 't', id: '1', name: 'm'.repeat(500) },
      details: { blob: 'd'.repeat(10_000) },
    });
    expect(prisma.rows[0]!.actorName).toHaveLength(200);
    expect(prisma.rows[0]!.actorName.endsWith('…')).toBe(true);
    expect(prisma.rows[0]!.targetName).toHaveLength(200);
    expect(prisma.rows[0]!.detailsJson).toHaveLength(4000);
  });

  it('that cannot be written fails nothing: the request it was about is answered all the same', async () => {
    const prisma = fakePrisma();
    fakePrisma.fail = true;
    try {
      const audit = new AuditService(prisma as never);
      await expect(
        audit.record({ actor: ada, action: 'x' }),
      ).resolves.toBeUndefined();
    } finally {
      fakePrisma.fail = false;
    }
  });

  it('names the account, or the key, or the system behind a request', () => {
    const audit = new AuditService(fakePrisma() as never);
    expect(audit.actorOf({ user: { id: 'u1', username: 'ada' } })).toEqual(ada);
    expect(audit.actorOf({ apiKey: { id: 'k1', name: 'ci' } })).toEqual({
      type: 'apiKey',
      id: 'k1',
      name: 'ci',
    });
    expect(audit.actorOf({})).toEqual({
      type: 'system',
      id: null,
      name: 'system',
    });
    expect(audit.ipOf({ ip: ' 10.0.0.7 ' })).toBe('10.0.0.7');
    expect(audit.ipOf({ ip: undefined })).toBeNull();
  });
});

describe('the pages', () => {
  const rowAt = (n: number, over: Partial<Row> = {}): Row => ({
    id: `e${String(n).padStart(3, '0')}`,
    at: new Date(Date.parse('2026-09-23T10:00:00Z') + n * 1000),
    actorType: 'user',
    actorId: 'u1',
    actorName: 'ada',
    action: n % 2 ? 'auth.login' : 'bridge.create',
    targetType: n % 2 ? null : 'bridge',
    targetId: n % 2 ? null : `b${n}`,
    targetName: null,
    detailsJson: null,
    ip: null,
    ...over,
  });

  it('come newest first, and the next page starts where the last one ended — never a duplicate, never a gap', async () => {
    const audit = new AuditService(
      fakePrisma([1, 2, 3, 4, 5].map((n) => rowAt(n))) as never,
    );
    const first = await audit.list({ limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual(['e005', 'e004']);
    expect(first.next).toBe('2026-09-23T10:00:04.000Z|e004');
    const second = await audit.list({ limit: 2, before: first.next! });
    expect(second.entries.map((e) => e.id)).toEqual(['e003', 'e002']);
    const third = await audit.list({ limit: 2, before: second.next! });
    expect(third.entries.map((e) => e.id)).toEqual(['e001']);
    expect(third.next).toBeNull();
  });

  it('two entries in the same instant are told apart by id', async () => {
    const same = new Date('2026-09-23T10:00:00Z');
    const audit = new AuditService(
      fakePrisma([
        rowAt(1, { at: same }),
        rowAt(2, { at: same }),
        rowAt(3, { at: same }),
      ]) as never,
    );
    const first = await audit.list({ limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual(['e003', 'e002']);
    const second = await audit.list({ limit: 2, before: first.next! });
    expect(second.entries.map((e) => e.id)).toEqual(['e001']);
  });

  it('can be narrowed by what was done, by whom, and to what', async () => {
    const audit = new AuditService(
      fakePrisma([
        rowAt(1),
        rowAt(2),
        rowAt(3, { actorName: 'bob' }),
        rowAt(4),
      ]) as never,
    );
    expect(
      (await audit.list({ limit: 50, action: 'bridge.create' })).entries.map(
        (e) => e.id,
      ),
    ).toEqual(['e004', 'e002']);
    expect(
      (await audit.list({ limit: 50, actor: 'bob' })).entries.map((e) => e.id),
    ).toEqual(['e003']);
    expect(
      (await audit.list({ limit: 50, targetId: 'b2' })).entries.map(
        (e) => e.id,
      ),
    ).toEqual(['e002']);
    expect(
      (await audit.list({ limit: 50, targetType: 'bridge' })).entries,
    ).toHaveLength(2);
  });

  it('a cursor that is not one is ignored, not an error', async () => {
    const audit = new AuditService(fakePrisma([rowAt(1)]) as never);
    expect(
      (await audit.list({ limit: 5, before: 'garbage' })).entries,
    ).toHaveLength(1);
  });

  it('an entry reads back as it was written; details that are not JSON are kept as text', async () => {
    const audit = new AuditService(
      fakePrisma([
        rowAt(1, {
          detailsJson: 'not json',
          targetType: 't',
          targetId: '1',
          targetName: 'n',
          ip: '::1',
        }),
      ]) as never,
    );
    const [entry] = (await audit.list({ limit: 1 })).entries;
    expect(entry).toMatchObject({
      id: 'e001',
      actor: ada,
      action: 'auth.login',
      target: { type: 't', id: '1', name: 'n' },
      details: { text: 'not json' },
      ip: '::1',
    });
  });

  it('pruning takes the oldest first, up to the budget, and nothing newer than the cutoff', async () => {
    const prisma = fakePrisma([1, 2, 3, 4, 5].map((n) => rowAt(n)));
    const audit = new AuditService(prisma as never);
    const cutoff = new Date(Date.parse('2026-09-23T10:00:00Z') + 4500);
    expect(await audit.prune(cutoff, 2)).toBe(2);
    expect(prisma.rows.map((r) => r.id)).toEqual(['e003', 'e004', 'e005']);
    expect(await audit.prune(cutoff, 100)).toBe(2);
    expect(prisma.rows.map((r) => r.id)).toEqual(['e005']);
    expect(await audit.prune(cutoff, 0)).toBe(0);
  });
});

describe('a route marked @Audited', () => {
  function run(meta: unknown, req: Record<string, unknown>, result: unknown) {
    const recorded: unknown[] = [];
    const audit = {
      record: vi.fn(async (e: unknown) => void recorded.push(e)),
      actorOf: () => ada,
      ipOf: () => '10.0.0.7',
    };
    const reflector = { get: () => meta };
    const interceptor = new AuditInterceptor(
      reflector as never,
      audit as never,
    );
    const context = {
      getHandler: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };
    return new Promise<unknown[]>((resolve) => {
      interceptor
        .intercept(context as never, { handle: () => of(result) } as never)
        .subscribe({ complete: () => setImmediate(() => resolve(recorded)) });
    });
  }

  it('is recorded when it succeeds: the action’s first word as the target’s type, the id from the route or the answer, the name from the answer or the request', async () => {
    const [entry] = await run(
      { action: 'bridge.create' },
      { params: {}, body: { name: 'from the body' } },
      { id: 'b1', name: 'orders' },
    );
    expect(entry).toEqual({
      actor: ada,
      action: 'bridge.create',
      target: { type: 'bridge', id: 'b1', name: 'orders' },
      details: null,
      ip: '10.0.0.7',
    });
    const [byRoute] = await run(
      { action: 'bridge.delete' },
      { params: { id: 'b9' }, body: { name: 'from the body' } },
      { ok: true },
    );
    expect((byRoute as { target: unknown }).target).toEqual({
      type: 'bridge',
      id: 'b9',
      name: 'from the body',
    });
  });

  it('what the route describes wins, and `target: null` means none', async () => {
    const meta = {
      action: 'settings.update',
      describe: () => ({ target: null, details: { sessionTtlMinutes: 30 } }),
    };
    const [entry] = await run(meta, { params: {}, body: {} }, {});
    expect(entry).toMatchObject({
      target: null,
      details: { sessionTtlMinutes: 30 },
    });
    const partial = {
      action: 'bridge.clone',
      describe: ({ params }: { params: Record<string, string> }) => ({
        details: { from: params.id },
      }),
    };
    const [clone] = await run(
      partial,
      { params: { id: 'b1' }, body: {} },
      { id: 'b2', name: 'copy' },
    );
    expect(clone).toMatchObject({
      target: { type: 'bridge', id: 'b1', name: 'copy' },
      details: { from: 'b1' },
    });
  });

  it('a description that throws costs the entry its details, not its existence', async () => {
    const meta = {
      action: 'bridge.run',
      describe: () => {
        throw new Error('boom');
      },
    };
    const [entry] = await run(
      meta,
      { params: { id: 'b1' }, body: {} },
      { id: 'j1' },
    );
    expect(entry).toMatchObject({
      action: 'bridge.run',
      target: { type: 'bridge', id: 'b1', name: null },
    });
  });

  it('sees through the `{ data }` envelope the response transform puts every answer in', async () => {
    const [entry] = await run(
      { action: 'connection.create' },
      { params: {}, body: { name: 'db' } },
      { data: { id: 'c1', name: 'db' } },
    );
    expect((entry as { target: unknown }).target).toEqual({
      type: 'connection',
      id: 'c1',
      name: 'db',
    });
  });

  it('a route that is not marked records nothing', async () => {
    expect(await run(undefined, { params: {} }, { id: 'x' })).toEqual([]);
  });

  it('without an id or a name there is no target, but still an entry', async () => {
    const [entry] = await run(
      { action: 'retention.run' },
      { params: {}, body: {} },
      { expiredDeliveries: 3 },
    );
    expect(entry).toMatchObject({ action: 'retention.run', target: null });
  });
});
