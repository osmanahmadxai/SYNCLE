import { describe, expect, it } from 'vitest';
import type { AdapterPoolService } from '../../../connections/adapter-pool.service';
import {
  MysqlCdcProvider,
  binlogEventStart,
  gtidFromEvent,
  normalizeBinlogRow,
} from './mysql-cdc.provider';

// cursorAfter/splitCursor are pure, the pool is only used by readiness()
const provider = new MysqlCdcProvider(null as unknown as AdapterPoolService);
const split = (c: string) => provider['splitCursor'](c);
const make = (a: Parameters<MysqlCdcProvider['makeCursor']>[0]) =>
  provider['makeCursor'](a);
const serverOf = (c: string) => provider['cursorServer'](c);

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

describe('server-identity cursors', () => {
  const base = { file: 'binlog.000007', pos: 900, row: 2, isStart: true };

  it('keeps the compact legacy form when the server is unknown', () => {
    expect(make({ ...base, serverUuid: null, gtid: null })).toBe(
      'binlog.000007:900:2:s',
    );
  });

  it('emits JSON carrying the server uuid when it is known', () => {
    const c = make({ ...base, serverUuid: 'uuid-a', gtid: 'uuid-a:12' });
    expect(serverOf(c)).toBe('uuid-a');
    expect(provider['cursorGtid'](c)).toBe('uuid-a:12');
  });

  it('parses back to the same coordinates it was built from', () => {
    const c = make({ ...base, serverUuid: 'uuid-a', gtid: null });
    expect(split(c)).toEqual(['binlog.000007', 900, 2, true]);
  });

  it('reports no server for a legacy cursor', () => {
    expect(serverOf('binlog.000007:900:2:s')).toBeNull();
  });

  it('survives a malformed JSON cursor without throwing', () => {
    expect(serverOf('{not json')).toBeNull();
    expect(split('{not json')).toEqual(['{not json', 0, -1, false]);
  });

  it('orders identically whether a cursor is JSON or legacy', () => {
    // a stream upgraded mid-flight compares old watermarks against new cursors
    const modern = make({
      file: 'b.000001',
      pos: 200,
      row: 0,
      isStart: true,
      serverUuid: 'u1',
      gtid: null,
    });
    expect(provider.cursorAfter(modern, 'b.000001:100:9:s')).toBe(true);
    expect(provider.cursorAfter('b.000001:300:0:s', modern)).toBe(true);
    expect(provider.cursorAfter(modern, 'b.000001:300:0:s')).toBe(false);
    // and against another JSON cursor
    const later = make({
      file: 'b.000001',
      pos: 400,
      row: 0,
      isStart: true,
      serverUuid: 'u1',
      gtid: null,
    });
    expect(provider.cursorAfter(later, modern)).toBe(true);
    expect(provider.cursorAfter(modern, later)).toBe(false);
  });
});

describe('gtidFromEvent', () => {
  it('formats the 16-byte server id and transaction number as a GTID', () => {
    const sid = Buffer.from('3E11FA47710C4A4EA9B4E75E1B1B2B3C', 'hex');
    expect(gtidFromEvent({ serverId: sid, transactionRange: 42 })).toBe(
      '3e11fa47-710c-4a4e-a9b4-e75e1b1b2b3c:42',
    );
  });

  it('returns null when the server id is not a 16-byte buffer', () => {
    expect(gtidFromEvent({ serverId: 'nope', transactionRange: 1 })).toBeNull();
    expect(gtidFromEvent({ serverId: Buffer.alloc(4), transactionRange: 1 })).toBeNull();
    expect(gtidFromEvent({})).toBeNull();
  });
});

describe('normalizeBinlogRow: a binlog row looks like the same row read with a SELECT', () => {
  const columns = [
    { name: 'id', type: 3 },
    { name: 'doc', type: 245 }, // MYSQL_TYPE_JSON
    { name: 'note', type: 253 }, // VARCHAR
  ];

  it('parses a JSON column, which the reader hands over as text', () => {
    const row = { id: 1, doc: '{"a":{"b":[1,2]}}', note: 'x' };
    expect(normalizeBinlogRow(row, columns)).toEqual({
      id: 1,
      doc: { a: { b: [1, 2] } },
      note: 'x',
    });
    expect(row.doc).toBe('{"a":{"b":[1,2]}}'); // the reader's row is not mutated
  });

  it('keeps JSON scalars as the values they are', () => {
    expect(normalizeBinlogRow({ doc: '"123"' }, columns).doc).toBe('123');
    expect(normalizeBinlogRow({ doc: '[]' }, columns).doc).toEqual([]);
    expect(normalizeBinlogRow({ doc: 'null' }, columns).doc).toBeNull();
  });

  it('never touches a text column that merely contains JSON', () => {
    const row = { id: 1, doc: null, note: '{"looks":"like json"}' };
    expect(normalizeBinlogRow(row, columns)).toBe(row);
  });

  it('leaves unparseable text, nulls and missing metadata alone', () => {
    expect(normalizeBinlogRow({ doc: '{broken' }, columns).doc).toBe('{broken');
    const row = { id: 1, doc: null };
    expect(normalizeBinlogRow(row, columns)).toBe(row);
    expect(normalizeBinlogRow(row, undefined)).toBe(row);
    // a delete image may carry only some columns
    expect(normalizeBinlogRow({ id: 5 }, columns)).toEqual({ id: 5 });
  });
});

describe('inspect: is the saved place in the binlog still there', () => {
  /** a provider whose server answers from a script */
  const providerOn = (server: { uuid: string | null; logs: string[] | Error }) => {
    const pool = {
      withAdapter: async (_c: string, _d: string | undefined, fn: (a: unknown) => unknown) =>
        fn({
          query: async (sql: string) => {
            if (sql.includes('server_uuid')) return { rows: server.uuid ? [{ uuid: server.uuid }] : [] };
            if (sql.includes('SHOW BINARY LOGS')) {
              if (server.logs instanceof Error) throw server.logs;
              return { rows: server.logs.map((Log_name) => ({ Log_name, File_size: 1 })) };
            }
            return { rows: [] };
          },
        }),
    };
    return new MysqlCdcProvider(pool as unknown as AdapterPoolService);
  };
  const bridge = { source: { kind: 'table', connectionId: 'c', table: 't' } } as never;
  const conn = {} as never;
  const cursor = make({ file: 'binlog.000007', pos: 1540, row: 0, isStart: true, serverUuid: 'uuid-A', gtid: null });

  it('holds nothing before it has a position', async () => {
    expect(await providerOn({ uuid: 'uuid-A', logs: [] }).inspect('b', bridge, conn, null)).toBeNull();
  });

  it('is fine while the file is still listed — and claims no WAL-like cost', async () => {
    const hold = await providerOn({ uuid: 'uuid-A', logs: ['binlog.000006', 'binlog.000007'] }).inspect(
      'b',
      bridge,
      conn,
      cursor,
    );
    expect(hold).toEqual({
      engine: 'mysql',
      kind: 'log-position',
      name: 'binlog.000007',
      exists: true,
      active: null,
      retainedBytes: null,
      limitBytes: null,
      status: 'ok',
    });
  });

  it('is lost once the file has been purged, and names the oldest one left', async () => {
    const hold = await providerOn({ uuid: 'uuid-A', logs: ['binlog.000009', 'binlog.000010'] }).inspect(
      'b',
      bridge,
      conn,
      cursor,
    );
    expect(hold).toMatchObject({ exists: false, status: 'lost' });
    expect(hold!.detail).toMatch(/binlog\.000007 has been purged.*binlog\.000009/);
  });

  it('is lost when the connection now reaches a different server', async () => {
    const hold = await providerOn({ uuid: 'uuid-B', logs: ['binlog.000007'] }).inspect('b', bridge, conn, cursor);
    expect(hold).toMatchObject({ exists: false, status: 'lost' });
    expect(hold!.detail).toMatch(/came from MySQL server uuid-A.*now reaches uuid-B/);
  });

  it('does not call a position lost on the strength of an empty listing', async () => {
    // binary logging reported as off, or a proxy that answers with nothing
    const hold = await providerOn({ uuid: 'uuid-A', logs: [] }).inspect('b', bridge, conn, cursor);
    expect(hold).toMatchObject({ exists: true, status: 'ok' });
  });

  it('lets a failure to look surface, rather than guessing', async () => {
    await expect(
      providerOn({ uuid: 'uuid-A', logs: new Error('Access denied; you need REPLICATION CLIENT') }).inspect(
        'b',
        bridge,
        conn,
        cursor,
      ),
    ).rejects.toThrow(/REPLICATION CLIENT/);
  });
});
