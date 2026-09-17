import { describe, expect, it } from 'vitest';
import { bridgeInputSchema } from './bridge-config';
import {
  columnsUsed,
  describeDrift,
  diffColumns,
  type SchemaColumn,
} from './schema-drift';

const col = (name: string, type = 'text', nullable = true): SchemaColumn => ({
  name,
  type,
  nullable,
});

describe('diffColumns', () => {
  const base = [col('id', 'integer', false), col('email'), col('name')];

  it('is null when the table is what it was — whatever the order, or the case of a type', () => {
    expect(diffColumns(base, base)).toBeNull();
    expect(diffColumns(base, [...base].reverse())).toBeNull();
    expect(
      diffColumns(base, [
        col('id', 'INTEGER', false),
        col('email', ' Text '),
        col('name'),
      ]),
    ).toBeNull();
    // nullability alone is not something a bridge can break on
    expect(
      diffColumns(base, [
        col('id', 'integer', true),
        col('email'),
        col('name'),
      ]),
    ).toBeNull();
    expect(diffColumns([], [])).toBeNull();
  });

  it('says what was added, removed and retyped', () => {
    const now = [
      col('id', 'bigint', false),
      col('mail'),
      col('name'),
      col('created_at', 'timestamptz'),
    ];
    expect(diffColumns(base, now)).toEqual({
      // a rename is a removal and an addition: nothing in a catalog says otherwise
      added: [col('mail'), col('created_at', 'timestamptz')],
      removed: [col('email')],
      retyped: [{ name: 'id', from: 'integer', to: 'bigint' }],
    });
    expect(describeDrift(diffColumns(base, now)!)).toBe(
      'removed: email; added: mail (text), created_at (timestamptz); changed type: id (integer → bigint)',
    );
  });
});

describe('the columns a bridge cannot do without', () => {
  const bridge = (over: Record<string, unknown>) =>
    bridgeInputSchema.parse({
      name: 'b',
      source: { kind: 'table', connectionId: 'c', table: 't' },
      destination: {
        kind: 'database',
        targets: [{ connectionId: 'd', table: 't', keyColumns: ['id'] }],
      },
      transform: { template: '{{$row}}' },
      ...over,
    });

  it('with no mapping: only the key — the rest of the row is taken as it comes', () => {
    expect(columnsUsed(bridge({}))).toEqual(['id']);
  });

  it('everything it maps BY NAME, in every target', () => {
    expect(
      columnsUsed(
        bridge({
          destination: {
            kind: 'database',
            targets: [
              {
                connectionId: 'd',
                table: 'a',
                keyColumns: ['uid'],
                mapping: [
                  { source: 'id', target: 'uid' },
                  { source: 'email', target: 'mail' },
                ],
              },
              {
                connectionId: 'd',
                table: 'b',
                keyColumns: ['id'],
                mapping: [
                  { source: 'id', target: 'id' },
                  { source: 'name', target: 'name' },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual(['email', 'id', 'name']);
  });

  it('what it filters, sorts and transforms by — but not the columns a transform ADDS', () => {
    expect(
      columnsUsed(
        bridge({
          source: {
            kind: 'table',
            connectionId: 'c',
            table: 't',
            filters: [{ column: 'active', operator: 'eq', value: true }],
            sort: [{ column: 'created_at', direction: 'asc' }],
          },
          transform: {
            template: '{{$row}}',
            columns: [
              { kind: 'mask', column: 'ssn', mode: 'hash' },
              { kind: 'set', column: 'label', template: '{{first}} {{last}}' },
              { kind: 'default', column: 'tier', value: 'free' },
            ],
          },
        }),
      ),
    ).toEqual(['active', 'created_at', 'first', 'id', 'last', 'ssn']);
  });

  it('the column a polling bridge polls by, and the fields an HTTP payload pins', () => {
    expect(
      columnsUsed(
        bridge({
          destination: { kind: 'http', url: 'https://example.com' },
          transform: { template: '{{$row}}', fields: ['id', 'email'] },
          trigger: {
            kind: 'watch',
            strategy: { strategy: 'timestamp', column: 'updated_at' },
          },
        }),
      ),
    ).toEqual(['email', 'id', 'updated_at']);
    // a template that names columns needs them: gone, they render as null, or as nothing
    expect(
      columnsUsed(
        bridge({
          destination: { kind: 'http', url: 'https://example.com' },
          transform: {
            template:
              '{"who": "{{ email }}", "ref": "u-{{id}}", "at": "{{$now}}", "all": "{{$row}}"}',
          },
        }),
      ),
    ).toEqual(['email', 'id']);
    // …which is the payload's business only: a database target never sees the template
    expect(
      columnsUsed(bridge({ transform: { template: '{"who": "{{email}}"}' } })),
    ).toEqual(['id']);
    // a snapshot poll diffs primary keys: no column of its own
    expect(
      columnsUsed(
        bridge({
          trigger: { kind: 'watch', strategy: { strategy: 'snapshot' } },
        }),
      ),
    ).toEqual(['id']);
  });
});
