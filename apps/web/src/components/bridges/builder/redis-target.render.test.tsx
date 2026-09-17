/**
 * a target in Redis, in the builder: what the form shows for it (and what it
 * stops showing — a table, a write mode, key columns, a soft delete), in every
 * language; and what it sends to the API.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgeInputSchema } from '@syncle/core';
import { queryKeys } from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { DbTargetsEditor } from './db-targets-editor';
import { blankDbTarget, initialDraft, type DbTarget } from './draft';
import { buildInput, loadBridge } from './mapping';
import { defaultKeyTemplate, redisTargetProblem } from './redis-target';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

const CONNECTIONS = [
  { id: 'c-redis', name: 'cache', engine: 'redis', readOnly: false },
  { id: 'c-pg', name: 'warehouse', engine: 'postgres', readOnly: false },
];

function render(locale: string, target: DbTarget): string {
  const client = new QueryClient();
  // (rendered on the server, the store is read in its initial state: no workspace yet)
  client.setQueryData(
    [...queryKeys.connections, useStudio.getInitialState().activeWorkspaceId],
    CONNECTIONS,
  );
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(e) => problems.push(e.message)}
    >
      <QueryClientProvider client={client}>
        <DbTargetsEditor
          targets={[target]}
          dispatch={() => undefined}
          sourceColumns={['id', 'email', 'name']}
          sourcePk="id"
          sourceTable="users"
        />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(/bridgeBuilder\.\w/);
  return html;
}

const inRedis = (over: Partial<DbTarget> = {}): DbTarget => ({
  ...blankDbTarget(),
  connectionId: 'c-redis',
  table: 'keys',
  redisMode: 'template',
  redisKeyTemplate: 'users:{{id}}',
  ...over,
});

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  const m = (
    messagesOf(locale) as unknown as {
      bridgeBuilder: Record<string, string> & {
        redis: Record<string, string> & { problem: Record<string, string> };
      };
    }
  ).bridgeBuilder;

  it('a key per row: the key, what it holds, when it expires — and nothing that only a table has', () => {
    const html = render(locale, inRedis({ redisTtlSeconds: 3600 }));
    expect(html).toContain('value="users:{{id}}"');
    expect(html).toContain('value="3600"');
    // the columns, ready to be put into the key — braces and all
    for (const column of ['id', 'email', 'name'])
      expect(html).toContain(`{{${column}}}`);
    // the hint spells a key template out: its braces are the message's own text, not placeholders
    expect(html).toContain('user:{{id}}');
    expect(html).toContain(
      m.redis.typeHashHint!.replace(/&/g, '&amp;').replace(/'/g, '&#x27;'),
    );
    for (const gone of [
      m.targetTable!,
      m.writeMode!,
      m.createIfMissing!,
      m.keyColumns!,
    ])
      expect(html).not.toContain(`>${gone}<`);
    expect(html).not.toContain('role="alert"');
  });

  it('says what is wrong with the key, in words', () => {
    expect(render(locale, inRedis({ redisKeyTemplate: 'users' }))).toContain(
      m.redis.problem.keyNoColumn!,
    );
    expect(render(locale, inRedis({ redisKeyTemplate: '' }))).toContain(
      m.redis.problem.keyEmpty!,
    );
    const unknown = render(
      locale,
      inRedis({ redisKeyTemplate: 'users:{{uuid}}' }),
    );
    expect(unknown).toContain('uuid');
    expect(unknown).toContain('role="alert"');
    expect(render(locale, inRedis({ redisType: 'string' }))).toContain(
      m.redis.problem.valueColumn!,
    );
    expect(render(locale, inRedis({ redisTtlSeconds: 0 }))).toContain(
      m.redis.problem.ttl!,
    );
  });

  it('a string shows which column; a hash and a document do not ask', () => {
    expect(
      render(
        locale,
        inRedis({ redisType: 'string', redisValueColumn: 'name' }),
      ),
    ).toContain(m.redis.valueColumn!);
    expect(render(locale, inRedis({ redisType: 'json' }))).not.toContain(
      `>${m.redis.valueColumn!}<`,
    );
  });

  it('the old way is still there, and says what it needs', () => {
    const html = render(
      locale,
      inRedis({ redisMode: 'columns', redisKeyTemplate: '' }),
    );
    expect(html).toContain(m.redis.modeColumnsHint!.replace(/&/g, '&amp;'));
    expect(html).not.toContain('id="redis-key-template"');
  });

  it('a table is a table: none of this is shown for one', () => {
    const html = render(locale, {
      ...blankDbTarget(),
      connectionId: 'c-pg',
      table: 'users_copy',
      keyColumns: ['id'],
    });
    expect(html).not.toContain(m.redis.mode!);
    expect(html).toContain(m.targetTable!);
  });
});

describe('what the form sends', () => {
  const ctx = {
    columns: ['id', 'email', 'name'],
    singlePk: 'id',
    fallbackName: 'users to cache',
    sourceEngine: 'postgres',
  };
  const draftWith = (target: DbTarget) => ({
    ...initialDraft(),
    name: 'users to cache',
    connectionId: 'src',
    table: 'users',
    destKind: 'database' as const,
    dbTargets: [target],
    included: new Set(ctx.columns),
  });

  it('a key per row goes out as a `redis` block, and comes back as the same form', () => {
    const target = inRedis({
      redisType: 'string',
      redisValueColumn: 'name',
      redisTtlSeconds: 60,
      onDelete: 'soft',
    });
    const input = buildInput(draftWith(target), ctx);
    const parsed = bridgeInputSchema.parse(input);
    expect(
      parsed.destination.kind === 'database' && parsed.destination.targets[0],
    ).toMatchObject({
      table: 'keys',
      // a key cannot be marked deleted: the form does not let it be asked for
      onDelete: 'delete',
      keyColumns: ['id'],
      redis: {
        keyTemplate: 'users:{{id}}',
        type: 'string',
        valueColumn: 'name',
        ttlSeconds: 60,
      },
    });
    expect(
      (input.destination as { targets: Array<{ softDelete?: unknown }> })
        .targets[0]!.softDelete,
    ).toBeUndefined();

    const back = loadBridge({
      ...parsed,
      id: 'b1',
      createdAt: '',
      updatedAt: '',
    } as never);
    expect(back.dbTargets[0]).toMatchObject({
      redisMode: 'template',
      redisKeyTemplate: 'users:{{id}}',
      redisType: 'string',
      redisValueColumn: 'name',
      redisTtlSeconds: 60,
    });
  });

  it('a hash sends no value column, and no expiry when none was given', () => {
    const input = buildInput(
      draftWith(inRedis({ redisValueColumn: 'left over from a string' })),
      ctx,
    );
    expect(
      (input.destination as { targets: Array<{ redis?: unknown }> }).targets[0]!
        .redis,
    ).toEqual({
      keyTemplate: 'users:{{id}}',
      type: 'hash',
      valueColumn: undefined,
      ttlSeconds: undefined,
    });
    expect(() => bridgeInputSchema.parse(input)).not.toThrow();
  });

  it('a target without a key template sends no `redis` block at all', () => {
    const input = buildInput(
      draftWith({
        ...blankDbTarget(),
        connectionId: 'c-pg',
        table: 'users_copy',
        keyColumns: ['id'],
        redisKeyTemplate: 'ignored',
      }),
      ctx,
    );
    expect(
      (input.destination as { targets: Array<Record<string, unknown>> })
        .targets[0],
    ).not.toHaveProperty('redis');
  });
});

describe('a key to start from, and what is wrong with one', () => {
  it('the table as the prefix, the row’s key as the rest', () => {
    expect(defaultKeyTemplate('users', 'id', ['id', 'name'])).toBe(
      'users:{{id}}',
    );
    expect(
      defaultKeyTemplate('public.order items', null, ['sku', 'name']),
    ).toBe('public.order_items:{{sku}}');
    expect(defaultKeyTemplate(null, null, [])).toBe('row:{{id}}');
  });

  it('follows the API’s rules, so that what the form lets through the API takes', () => {
    const columns = ['id', 'name'];
    const base = {
      redisKeyTemplate: 'u:{{id}}',
      redisType: 'hash' as const,
      redisValueColumn: '',
      redisTtlSeconds: null,
    };
    expect(redisTargetProblem(base, columns)).toBeNull();
    expect(
      redisTargetProblem({ ...base, redisKeyTemplate: '  ' }, columns),
    ).toEqual({ problem: 'keyEmpty' });
    expect(
      redisTargetProblem({ ...base, redisKeyTemplate: 'u' }, columns),
    ).toEqual({ problem: 'keyNoColumn' });
    expect(
      redisTargetProblem(
        { ...base, redisKeyTemplate: 'u:{{ id }}:{{nope}}' },
        columns,
      ),
    ).toEqual({ problem: 'keyUnknownColumn', column: 'nope' });
    expect(
      redisTargetProblem({ ...base, redisType: 'string' }, columns),
    ).toEqual({ problem: 'valueColumn' });
    expect(
      redisTargetProblem(
        { ...base, redisType: 'string', redisValueColumn: 'name' },
        columns,
      ),
    ).toBeNull();
    expect(
      redisTargetProblem({ ...base, redisTtlSeconds: 1.5 }, columns),
    ).toEqual({ problem: 'ttl' });
    expect(
      redisTargetProblem({ ...base, redisTtlSeconds: 1 }, columns),
    ).toBeNull();
  });
});
