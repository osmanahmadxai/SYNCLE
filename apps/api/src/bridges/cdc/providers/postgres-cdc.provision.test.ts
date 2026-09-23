/**
 * What the Postgres provider refuses to set up, and what it asks the server
 * for when it does — with the database replaced by a double that answers the
 * catalog queries and records the rest.
 *
 * The refusals all guard against harm that would otherwise be SILENT: a
 * publication that makes the owner's UPDATEs fail, a partitioned table that
 * streams nothing, a delete that can never find its row.
 */
import { describe, expect, it } from 'vitest';
import { PostgresCdcProvider } from './postgres-cdc.provider';

/** these bridges have a slot of their own: the shared-slot service is only ever told they are not members */
const NOT_SHARED = {
  isMember: async () => false,
  leave: async () => undefined,
  join: async () => undefined,
  position: async () => null,
} as never;

interface Catalog {
  /** pg_class.relreplident: d = default (primary key), f = full, i = index, n = nothing */
  kind?: 'd' | 'f' | 'i' | 'n';
  columns?: string[];
  relkind?: 'r' | 'p';
  version?: number;
  /** the publication already on the server, if any */
  publication?: { schemaname: string; tablename: string } | null;
  slot?: boolean;
}

function providerFor(catalog: Catalog) {
  const statements: string[] = [];
  const adapter = {
    query: async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.includes('relreplident')) {
        return {
          rows: [
            {
              kind: catalog.kind ?? 'd',
              relkind: catalog.relkind ?? 'r',
              version: catalog.version ?? 160004,
              columns: catalog.columns ?? ['id'],
            },
          ],
        };
      }
      if (text.includes('from pg_publication pub')) {
        return { rows: catalog.publication ? [catalog.publication] : [] };
      }
      if (text.includes('from pg_replication_slots')) {
        return { rows: catalog.slot ? [{ slot_name: 'x' }] : [] };
      }
      statements.push(text);
      return { rows: [] };
    },
  };
  const pool = {
    withAdapter: async (
      _c: string,
      _d: string | undefined,
      fn: (a: unknown) => unknown,
    ) => fn(adapter),
  };
  return {
    provider: new PostgresCdcProvider(pool as never, NOT_SHARED),
    statements,
  };
}

const bridge = (
  operations: string[],
  targets: Array<{
    keyColumns: string[];
    mapping?: Array<{ source: string; target: string }>;
  }> = [{ keyColumns: ['id'] }],
  destinationKind: 'database' | 'http' = 'database',
) =>
  ({
    id: 'b1',
    source: { kind: 'table', connectionId: 'c', table: 'orders' },
    trigger: { kind: 'cdc', operations },
    destination:
      destinationKind === 'http'
        ? { kind: 'http', url: 'https://example.test' }
        : {
            kind: 'database',
            targets: targets.map((t) => ({
              connectionId: 'd',
              table: 'orders_copy',
              mapping: [],
              ...t,
            })),
          },
  }) as never;

describe('a table with no replica identity', () => {
  const noIdentity: Catalog = { kind: 'd', columns: [] }; // default identity, but no primary key

  it('is refused for updates and deletes — publishing them would break UPDATE/DELETE at the source', async () => {
    const { provider, statements } = providerFor(noIdentity);
    await expect(
      provider.provision('b-1', bridge(['insert', 'update'])),
    ).rejects.toThrow(/no primary key and no replica identity/);
    await expect(provider.provision('b-1', bridge(['delete']))).rejects.toThrow(
      /REPLICA IDENTITY FULL/,
    );
    // refused BEFORE anything was created on someone's database
    expect(statements).toEqual([]);
  });

  it('can still be captured insert-only, and then ONLY inserts are published', async () => {
    const { provider, statements } = providerFor(noIdentity);
    await provider.provision('b-1', bridge(['insert']));
    const create = statements.find((s) => s.startsWith('CREATE PUBLICATION'))!;
    expect(create).toContain(`publish = 'insert, truncate'`);
    expect(create).not.toMatch(/update|delete/);
  });

  it('REPLICA IDENTITY NOTHING is the same situation', async () => {
    const { provider } = providerFor({ kind: 'n', columns: [] });
    await expect(provider.provision('b-1', bridge(['update']))).rejects.toThrow(
      /replica identity/,
    );
  });

  it('REPLICA IDENTITY FULL needs no key at all', async () => {
    const { provider } = providerFor({ kind: 'f', columns: [] });
    await expect(
      provider.provision('b-1', bridge(['insert', 'update', 'delete'])),
    ).resolves.toBeUndefined();
  });
});

describe('a delete that could never find its row', () => {
  it('is refused when a target is keyed on a column the DELETE message does not carry', async () => {
    const { provider, statements } = providerFor({ columns: ['id'] });
    await expect(
      provider.provision(
        'b-1',
        bridge(['insert', 'delete'], [{ keyColumns: ['email'] }]),
      ),
    ).rejects.toThrow(
      /Deletes cannot reach orders_copy.*keyed on email.*only carries id/s,
    );
    expect(statements).toEqual([]);
  });

  it('follows the column mapping back to the source column', async () => {
    const { provider } = providerFor({ columns: ['id'] });
    const mapped = [
      {
        keyColumns: ['order_id'],
        mapping: [{ source: 'id', target: 'order_id' }],
      },
    ];
    await expect(
      provider.provision('b-1', bridge(['delete'], mapped)),
    ).resolves.toBeUndefined();
  });

  it('checks every target, not just the first', async () => {
    const { provider } = providerFor({ columns: ['id'] });
    await expect(
      provider.provision(
        'b-1',
        bridge(['delete'], [{ keyColumns: ['id'] }, { keyColumns: ['sku'] }]),
      ),
    ).rejects.toThrow(/keyed on sku/);
  });

  it('is fine when the table sends whole rows, or deletes are not captured, or nothing is keyed', async () => {
    const other = [{ keyColumns: ['email'] }];
    await expect(
      providerFor({ kind: 'f' }).provider.provision(
        'b',
        bridge(['delete'], other),
      ),
    ).resolves.toBeUndefined();
    await expect(
      providerFor({}).provider.provision(
        'b',
        bridge(['insert', 'update'], other),
      ),
    ).resolves.toBeUndefined();
    await expect(
      providerFor({}).provider.provision('b', bridge(['delete'], [], 'http')),
    ).resolves.toBeUndefined();
  });

  it('accepts a composite identity used in any order', async () => {
    const { provider } = providerFor({ columns: ['tenant', 'id'] });
    await expect(
      provider.provision(
        'b-1',
        bridge(['delete'], [{ keyColumns: ['id', 'tenant'] }]),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('a partitioned table', () => {
  it('is published through its root, so changes arrive under the name the bridge reads', async () => {
    const { provider, statements } = providerFor({ relkind: 'p' });
    await provider.provision('b-1', bridge(['insert']));
    expect(
      statements.find((s) => s.startsWith('CREATE PUBLICATION')),
    ).toContain('publish_via_partition_root = true');
  });

  it('is refused on PostgreSQL 12, which cannot do that', async () => {
    const { provider, statements } = providerFor({
      relkind: 'p',
      version: 120018,
    });
    await expect(provider.provision('b-1', bridge(['insert']))).rejects.toThrow(
      /partitioned.*PostgreSQL 12/s,
    );
    expect(statements).toEqual([]);
  });

  it('an ordinary table on PostgreSQL 12 is not asked for an option it does not know', async () => {
    const { provider, statements } = providerFor({ version: 120018 });
    await provider.provision('b-1', bridge(['insert']));
    expect(statements.join('\n')).not.toContain('publish_via_partition_root');
  });
});

describe('the publication', () => {
  it('always carries truncate, so a bridge can at least SAY its source was emptied', async () => {
    const { provider, statements } = providerFor({});
    await provider.provision('b-1', bridge(['insert', 'update', 'delete']));
    expect(
      statements.find((s) => s.startsWith('CREATE PUBLICATION')),
    ).toContain(`publish = 'insert, update, delete, truncate'`);
  });

  it('is brought up to date when the bridge was edited, not left as first created', async () => {
    const { provider, statements } = providerFor({
      publication: { schemaname: 'public', tablename: 'orders' },
      slot: true,
    });
    await provider.provision('b-1', bridge(['insert']));
    expect(statements.some((s) => s.startsWith('CREATE PUBLICATION'))).toBe(
      false,
    );
    expect(statements.find((s) => s.startsWith('ALTER PUBLICATION'))).toContain(
      `publish = 'insert, truncate'`,
    );
    // and the slot that is already there is left alone
    expect(
      statements.some((s) => s.includes('pg_create_logical_replication_slot')),
    ).toBe(false);
  });

  it('quotes identifiers', async () => {
    const { provider, statements } = providerFor({});
    const odd = bridge(['insert']) as unknown as {
      source: { table: string; schema?: string };
    };
    odd.source.table = 'we"ird';
    odd.source.schema = 'My Schema';
    await provider.provision('b-1', odd as never);
    expect(
      statements.find((s) => s.startsWith('CREATE PUBLICATION')),
    ).toContain('"My Schema"."we""ird"');
  });
});
