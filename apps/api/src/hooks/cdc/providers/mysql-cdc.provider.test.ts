import { describe, expect, it } from 'vitest';
import type { AdapterPoolService } from '../../../connections/adapter-pool.service';
import { MysqlCdcProvider, binlogEventStart } from './mysql-cdc.provider';

// cursorAfter/splitCursor are pure, the pool is only used by readiness()
const provider = new MysqlCdcProvider(null as unknown as AdapterPoolService);
const split = (c: string) => provider['splitCursor'](c);

describe('splitCursor', () => {
  it('parses the current start-format cursor "file:pos:row:s"', () => {
    expect(split('binlog.000042:1540:3:s')).toEqual(['binlog.000042', 1540, 3, true]);
  });

  it('parses the legacy end-format cursor "file:pos:row"', () => {
    expect(split('binlog.000042:1540:3')).toEqual(['binlog.000042', 1540, 3, false]);
  });

  it('parses the oldest "file:pos" cursor with row index -1', () => {
    expect(split('binlog.000042:1540')).toEqual(['binlog.000042', 1540, -1, false]);
  });

  it('keeps a filename containing colons intact', () => {
    expect(split('my:log.000001:200:0:s')).toEqual(['my:log.000001', 200, 0, true]);
    expect(split('my:log.000001:200:0')).toEqual(['my:log.000001', 200, 0, false]);
  });
});

describe('cursorAfter', () => {
  it('a null watermark means everything is new', () => {
    expect(provider.cursorAfter('binlog.000001:4:0:s', null)).toBe(true);
  });

  it('orders by file first (zero-padded names compare lexically)', () => {
    expect(provider.cursorAfter('binlog.000002:4:0:s', 'binlog.000001:9999:5:s')).toBe(true);
    expect(provider.cursorAfter('binlog.000001:9999:5:s', 'binlog.000002:4:0:s')).toBe(false);
  });

  it('then by position, then by row index', () => {
    expect(provider.cursorAfter('b.000001:200:0:s', 'b.000001:100:9:s')).toBe(true);
    expect(provider.cursorAfter('b.000001:100:4:s', 'b.000001:100:3:s')).toBe(true);
    expect(provider.cursorAfter('b.000001:100:3:s', 'b.000001:100:3:s')).toBe(false);
    expect(provider.cursorAfter('b.000001:100:2:s', 'b.000001:100:3:s')).toBe(false);
  });

  it('drops the already-delivered prefix of a replayed statement (mid-event resume)', () => {
    // crash happened after row 2 of a 5-row statement whose tablemap starts at 500
    const watermark = 'b.000001:500:2:s';
    // resume re-enters at 500 and replays rows 0..4
    expect(provider.cursorAfter('b.000001:500:0:s', watermark)).toBe(false);
    expect(provider.cursorAfter('b.000001:500:2:s', watermark)).toBe(false);
    expect(provider.cursorAfter('b.000001:500:3:s', watermark)).toBe(true);
    expect(provider.cursorAfter('b.000001:500:4:s', watermark)).toBe(true);
  });

  it('a start-format cursor at the offset where a legacy cursor ENDED is after it', () => {
    // legacy watermark: event ended at 800; the next statement's tablemap can
    // start at exactly 800, and its rows must not be dropped by the tie
    expect(provider.cursorAfter('b.000001:800:0:s', 'b.000001:800:7')).toBe(true);
    // and the mirror image: a legacy cursor at a start-format watermark's
    // offset belongs to the event BEFORE it
    expect(provider.cursorAfter('b.000001:800:7', 'b.000001:800:0:s')).toBe(false);
  });

  it('legacy 2-part watermarks compare as row -1, so row 0 still delivers', () => {
    expect(provider.cursorAfter('b.000001:800:0', 'b.000001:800')).toBe(true);
    expect(provider.cursorAfter('b.000001:799:0', 'b.000001:800')).toBe(false);
  });
});

describe('binlogEventStart (resume-position math)', () => {
  it('subtracts payload size and the 19-byte header', () => {
    // tablemap payload of 41 bytes ending at 560 starts at 560 - 41 - 19 = 500
    expect(binlogEventStart({ nextPosition: 560, size: 41 }, false)).toBe(500);
  });

  it('accounts for the 4-byte CRC32 when binlog_checksum is on', () => {
    // zongji strips the checksum from `size`, but next_position includes it
    expect(binlogEventStart({ nextPosition: 564, size: 41 }, true)).toBe(500);
  });
});
