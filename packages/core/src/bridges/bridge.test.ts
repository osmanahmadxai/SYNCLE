import { describe, expect, it } from 'vitest';
import {
  buildCreateTableSpec,
  destinationLabel,
  destinationNodeKeys,
  mapRow,
} from './bridge';
import type { BridgeDestination } from './bridge-config';

describe('mapRow', () => {
  it('is identity (undefined → null) with no mapping', () => {
    expect(mapRow({ a: 1, b: undefined }, [])).toEqual({ a: 1, b: null });
  });

  it('projects + renames to target columns with a mapping', () => {
    const out = mapRow({ id: 7, full_name: 'Ada', extra: 'x' }, [
      { source: 'id', target: 'user_id' },
      { source: 'full_name', target: 'name' },
    ]);
    expect(out).toEqual({ user_id: 7, name: 'Ada' });
    expect(out).not.toHaveProperty('extra');
  });
});

describe('buildCreateTableSpec', () => {
  it('makes key columns NOT NULL primary keys and types per engine', () => {
    const spec = buildCreateTableSpec(
      'users',
      'public',
      [
        { name: 'id', sourceType: 'integer', nullable: false },
        { name: 'name', sourceType: 'text', nullable: true },
      ],
      ['id'],
      'mysql',
    );
    expect(spec.table).toBe('users');
    const id = spec.columns.find((c) => c.name === 'id')!;
    expect(id.primaryKey).toBe(true);
    expect(id.nullable).toBe(false);
    expect(id.type).toBe('INT');
    // MySQL's TEXT stops at 64 KB and the source's `text` does not
    expect(spec.columns.find((c) => c.name === 'name')!.type).toBe('LONGTEXT');
  });

  it('uses an indexable type for a text KEY column on MySQL', () => {
    const spec = buildCreateTableSpec(
      'k',
      undefined,
      [{ name: 'slug', sourceType: 'text', nullable: false }],
      ['slug'],
      'mysql',
    );
    expect(spec.columns[0]!.type).toBe('VARCHAR(255)');
  });
});

describe('destination display helpers', () => {
  const db: BridgeDestination = {
    kind: 'database',
    targets: [
      {
        connectionId: 'c1',
        table: 'users',
        schema: 'public',
        writeMode: 'upsert',
        keyColumns: ['id'],
        mapping: [],
        createMissingTable: true,
      },
      {
        connectionId: 'c2',
        table: 'people',
        writeMode: 'upsert',
        keyColumns: ['id'],
        mapping: [],
        createMissingTable: true,
      },
    ],
  };

  it('labels a multi-target database destination', () => {
    expect(destinationLabel(db)).toBe('public.users +1');
    expect(destinationNodeKeys(db)).toEqual([
      'db:c1:public.users',
      'db:c2:people',
    ]);
  });

  it('labels an HTTP destination by method + host', () => {
    const http: BridgeDestination = {
      kind: 'http',
      url: 'https://api.example.com/bridge',
      method: 'POST',
      auth: { type: 'none' },
      idempotency: false,
    };
    expect(destinationLabel(http)).toBe('POST api.example.com');
  });
});
