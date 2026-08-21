import { describe, expect, it } from 'vitest';
import { lsnAfter } from './postgres-cdc.provider';

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
