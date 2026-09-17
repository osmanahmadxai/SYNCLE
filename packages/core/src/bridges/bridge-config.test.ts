/**
 * bridge-config schemas: the defaults a bridge gets when a caller says nothing,
 * which is where a quiet, unsafe choice would hide.
 */
import { describe, expect, it } from 'vitest';
import {
  bridgeDeliverySchema,
  bridgeInputSchema,
  databaseTargetSchema,
  deadLetterDiscardSchema,
  deadLetterRetrySchema,
} from './bridge-config';

const minimal = {
  name: 'b',
  source: { kind: 'table', connectionId: 'src', table: 't' },
  destination: {
    kind: 'database',
    targets: [{ connectionId: 'dst', table: 't' }],
  },
  transform: {},
};

describe('delivery.onError', () => {
  it('defaults to stopping at a failure rather than stepping over it', () => {
    expect(bridgeDeliverySchema.parse({}).onError).toBe('abort');
    expect(bridgeInputSchema.parse(minimal).delivery.onError).toBe('abort');
  });

  it('keeps an explicit choice, so bridges saved as `continue` stay that way', () => {
    expect(bridgeDeliverySchema.parse({ onError: 'continue' }).onError).toBe(
      'continue',
    );
    expect(
      bridgeInputSchema.parse({ ...minimal, delivery: { onError: 'continue' } })
        .delivery.onError,
    ).toBe('continue');
  });

  it('rejects anything else', () => {
    expect(() => bridgeDeliverySchema.parse({ onError: 'ignore' })).toThrow();
  });
});

describe('dead-letter requests', () => {
  it('a retry with no body means every pending entry, unforced', () => {
    expect(deadLetterRetrySchema.parse({})).toEqual({ force: false });
  });

  it('force must be asked for explicitly, as a boolean', () => {
    expect(deadLetterRetrySchema.parse({ force: true }).force).toBe(true);
    expect(() => deadLetterRetrySchema.parse({ force: 'yes' })).toThrow();
  });

  it('bounds how many entries one call may name, and refuses an empty list', () => {
    const ids = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `id-${i}`);
    expect(deadLetterRetrySchema.parse({ ids: ids(500) }).ids).toHaveLength(
      500,
    );
    expect(() => deadLetterRetrySchema.parse({ ids: ids(501) })).toThrow();
    // an empty list is almost certainly a caller bug; "all" is spelled by omitting it
    expect(() => deadLetterRetrySchema.parse({ ids: [] })).toThrow();
    expect(() => deadLetterDiscardSchema.parse({ ids: [''] })).toThrow();
    expect(deadLetterDiscardSchema.parse({})).toEqual({});
  });
});

describe('what a delete does to a target', () => {
  const target = (extra: Record<string, unknown> = {}) =>
    databaseTargetSchema.safeParse({ connectionId: 'c', table: 't', keyColumns: ['id'], ...extra });

  it('removes the row unless told otherwise — what every target saved before this did', () => {
    const parsed = target();
    expect(parsed.success && parsed.data.onDelete).toBe('delete');
    expect(parsed.success && parsed.data.softDelete).toBeUndefined();
  });

  it('can be ignored, with nothing more to say', () => {
    expect(target({ onDelete: 'ignore' }).success).toBe(true);
  });

  it('a soft delete needs a column to mark the row with, and marks it with the time by default', () => {
    const bare = target({ onDelete: 'soft' });
    expect(bare.success).toBe(false);
    expect(!bare.success && bare.error.issues[0]).toMatchObject({ path: ['softDelete', 'column'] });
    expect(target({ onDelete: 'soft', softDelete: { column: '  ' } }).success).toBe(false);

    const ok = target({ onDelete: 'soft', softDelete: { column: ' deleted_at ' } });
    expect(ok.success && ok.data.softDelete).toEqual({ column: 'deleted_at', value: 'timestamp' });
    expect(target({ onDelete: 'soft', softDelete: { column: 'gone', value: 'boolean' } }).success).toBe(true);
    expect(target({ onDelete: 'soft', softDelete: { column: 'gone', value: 'tombstone' } }).success).toBe(false);
  });

  it('the marker is a column of its own: not a key, not one that receives source data', () => {
    const asKey = target({ onDelete: 'soft', softDelete: { column: 'id' } });
    expect(!asKey.success && asKey.error.issues[0]!.message).toMatch(/key column/);
    const mapped = target({
      onDelete: 'soft',
      softDelete: { column: 'deleted_at' },
      mapping: [
        { source: 'id', target: 'id' },
        { source: 'removed', target: 'deleted_at' },
      ],
    });
    expect(!mapped.success && mapped.error.issues[0]!.message).toMatch(/already receives a source column/);
    // the same NAME at the source, mapped elsewhere, is no clash
    expect(
      target({
        onDelete: 'soft',
        softDelete: { column: 'deleted_at' },
        mapping: [
          { source: 'id', target: 'id' },
          { source: 'deleted_at', target: 'source_deleted_at' },
        ],
      }).success,
    ).toBe(true);
  });

  it('a column left over from a soft delete does not get in the way of another policy', () => {
    expect(target({ onDelete: 'delete', softDelete: { column: 'id' } }).success).toBe(true);
  });
});

