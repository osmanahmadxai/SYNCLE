/**
 * bridge-config schemas: the defaults a bridge gets when a caller says nothing,
 * which is where a quiet, unsafe choice would hide.
 */
import { describe, expect, it } from 'vitest';
import {
  bridgeDeliverySchema,
  bridgeInputSchema,
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
