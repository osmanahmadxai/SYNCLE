import { describe, expect, it } from 'vitest';
import type { BridgeDelivery } from '@syncle/core';
import { csvCell, failureCsvLine, failureRecord } from './bridges.controller';

describe('a CSV cell', () => {
  it('is quoted only when it has to be, with quotes doubled', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell([1, 'two'])).toBe('"[1,""two""]"');
  });

  it('is never a formula: an error text or a row’s value is somebody else’s data, and a spreadsheet runs what starts with = + - @', () => {
    expect(csvCell('=HYPERLINK("http://evil.example","click")')).toBe(
      `"'=HYPERLINK(""http://evil.example"",""click"")"`,
    );
    expect(csvCell('+1+cmd|calc')).toBe(`'+1+cmd|calc`);
    expect(csvCell('-2')).toBe(`'-2`);
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('\tTabbed')).toBe(`'\tTabbed`);
    // a NUMBER that is negative is a number, not text that starts with a minus
    expect(csvCell(-2)).toBe(`'-2`);
    // not at the start: left alone
    expect(csvCell('a=b')).toBe('a=b');
  });
});

describe('a failed delivery, as a record', () => {
  const d: BridgeDelivery & { rowKeys: unknown[] } = {
    id: 'd1',
    jobId: 'j1',
    sequence: 7,
    rowIndex: 7,
    rowCount: 2,
    status: 'failed',
    httpStatus: 503,
    attempts: 3,
    error: 'upstream said "no", twice',
    requestBody: '[{"id":1}]',
    responseBody: 'nope',
    durationMs: 12,
    createdAt: '2026-09-17T10:00:00.000Z',
    op: 'update',
    rowKeys: [1, 2],
  };

  it('has what someone needs to find the rows and the reason', () => {
    expect(failureRecord(d)).toEqual({
      sequence: 7,
      operation: 'update',
      rows: 2,
      row_keys: [1, 2],
      attempts: 3,
      http_status: 503,
      error: 'upstream said "no", twice',
      at: '2026-09-17T10:00:00.000Z',
      payload: '[{"id":1}]',
    });
  });

  it('is one CSV line', () => {
    expect(failureCsvLine(d)).toBe(
      '7,update,2,"[1,2]",3,503,"upstream said ""no"", twice",2026-09-17T10:00:00.000Z,"[{""id"":1}]"',
    );
  });
});
