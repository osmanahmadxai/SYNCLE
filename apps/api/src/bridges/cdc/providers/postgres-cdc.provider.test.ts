import { describe, expect, it } from 'vitest';
import {
  formatLsn,
  lsnAfter,
  lsnForClient,
  parsePgCursor,
} from './postgres-cdc.provider';

describe('lsnAfter', () => {
  it('a null watermark means everything is new', () => {
    expect(lsnAfter('0/1', null)).toBe(true);
  });

  it('compares the low word numerically, not lexically', () => {
    expect(lsnAfter('0/A', '0/9')).toBe(true);
    expect(lsnAfter('0/10', '0/F')).toBe(true); // 0x10 > 0xF, but '10' < 'F' as strings
    expect(lsnAfter('0/F', '0/10')).toBe(false);
  });

  it('the high word dominates the low word', () => {
    // 1/0 is after 0/FFFFFFFF even though its low word is smaller
    expect(lsnAfter('1/0', '0/FFFFFFFF')).toBe(true);
    expect(lsnAfter('0/FFFFFFFF', '1/0')).toBe(false);
    expect(lsnAfter('A/5', '9/FFFFFFF0')).toBe(true);
  });

  it('equal LSNs are not after each other (strict ordering)', () => {
    expect(lsnAfter('16/B374D848', '16/B374D848')).toBe(false);
  });

  it('is conservative on malformed input: not-after, so no duplicate delivery', () => {
    expect(lsnAfter('junk', '0/1')).toBe(false);
    expect(lsnAfter('0/1', 'junk')).toBe(false);
    expect(lsnAfter('0', '0/1')).toBe(false);
  });
});

describe('lsnAfter with transaction-aware cursors', () => {
  it('orders by COMMIT position first: that is the order Postgres streams in', () => {
    // written earlier (0/10 < 0/30), committed later (0/50 > 0/40): it is AFTER
    expect(lsnAfter('0/50#0/10.0', '0/40#0/30.0')).toBe(true);
    expect(lsnAfter('0/40#0/30.0', '0/50#0/10.0')).toBe(false);
  });

  it('then by the change, then by its ordinal among changes sharing a WAL record', () => {
    expect(lsnAfter('0/50#0/20.0', '0/50#0/10.7')).toBe(true);
    expect(lsnAfter('0/50#0/20.1', '0/50#0/20.0')).toBe(true);
    expect(lsnAfter('0/50#0/20.10', '0/50#0/20.9')).toBe(true); // numeric, not lexical
    expect(lsnAfter('0/50#0/20.0', '0/50#0/20.0')).toBe(false);
    expect(lsnAfter('0/50#0/20.0', '0/50#0/20.1')).toBe(false);
  });

  it("a transaction's end is after all of its changes and before the next transaction", () => {
    expect(lsnAfter('0/50#c:0/58', '0/50#FFFFFFFF/FFFFFFFF.999')).toBe(true);
    expect(lsnAfter('0/50#0/20.0', '0/50#c:0/58')).toBe(false);
    expect(lsnAfter('0/58#0/8.0', '0/50#c:0/58')).toBe(true);
    expect(lsnAfter('0/50#c:0/58', '0/50#c:0/58')).toBe(false);
  });

  it('a cursor saved before this existed accepts every transaction committing at or after it', () => {
    // a legacy cursor was usually a COMMIT's end — which is exactly where the
    // next commit record can start
    expect(lsnAfter('0/50#0/10.0', '0/50')).toBe(true);
    expect(lsnAfter('0/60#0/10.0', '0/50')).toBe(true);
    expect(lsnAfter('0/4F#0/10.0', '0/50')).toBe(false);
    expect(lsnAfter('0/4F#c:0/50', '0/50')).toBe(false);
  });

  it('stays conservative on malformed cursors', () => {
    for (const bad of [
      '0/50#',
      '0/50#x',
      '0/50#0/20',
      '0/50#0/20.-1',
      '0/50#0/20.1.5x',
      '0/50#c:',
      '#0/20.0',
      '0/5/0#0/1.0',
    ]) {
      expect(lsnAfter(bad, '0/1')).toBe(false);
      expect(lsnAfter('FFFF/0#0/1.0', bad)).toBe(false);
    }
  });
});

describe('parsePgCursor', () => {
  it('reads each form', () => {
    expect(parsePgCursor('0/50#0/20.3')).toEqual({
      commit: 0x50n,
      change: 0x20n,
      ordinal: 3,
      ack: null,
    });
    expect(parsePgCursor('1/0#c:1/28')).toMatchObject({
      commit: 1n << 32n,
      ordinal: 0,
      ack: '1/28',
    });
    expect(parsePgCursor('0/50')).toEqual({
      commit: 0x50n,
      change: -1n,
      ordinal: 0,
      ack: '0/50',
    });
    expect(parsePgCursor('nope')).toBeNull();
  });

  it('only the end of a transaction (or a legacy cursor) may be confirmed', () => {
    expect(parsePgCursor('0/50#0/20.3')!.ack).toBeNull();
    expect(parsePgCursor('0/50#c:0/58')!.ack).toBe('0/58');
  });
});

describe('lsnForClient', () => {
  it('is one byte before, because the client adds one', () => {
    expect(lsnForClient('0/60')).toBe('0/5F');
    expect(lsnForClient('00000001/BD940538')).toBe('1/BD940537');
  });

  it('borrows across the word boundary', () => {
    expect(lsnForClient('1/0')).toBe('0/FFFFFFFF');
  });

  it('has nothing to offer for the start of the WAL or for junk', () => {
    expect(lsnForClient('0/0')).toBeNull();
    expect(lsnForClient('junk')).toBeNull();
  });

  it('formatLsn prints the way Postgres does', () => {
    expect(formatLsn(0x16b374d848n)).toBe('16/B374D848');
    expect(formatLsn(0n)).toBe('0/0');
  });
});
