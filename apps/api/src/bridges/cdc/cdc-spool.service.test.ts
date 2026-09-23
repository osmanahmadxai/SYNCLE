/**
 * nextStreamId is what makes trimming correct: XTRIM MINID removes entries
 * strictly BELOW the given id, so trimming *through* a delivered entry means
 * trimming below its successor. Getting this wrong either leaves the last
 * delivered entry behind forever (it would be redelivered on every pass) or
 * trims one too many (silent data loss).
 */
import { describe, expect, it } from 'vitest';
import { decodeEntry, encodeEntry, nextStreamId } from './cdc-spool.service';

describe('nextStreamId', () => {
  it('increments the sequence part', () => {
    expect(nextStreamId('1700000000000-0')).toBe('1700000000000-1');
    expect(nextStreamId('1700000000000-41')).toBe('1700000000000-42');
  });

  it('leaves the millisecond part untouched', () => {
    expect(nextStreamId('12345-7')).toBe('12345-8');
  });

  it('returns the input unchanged when it is not a stream id', () => {
    expect(nextStreamId('nonsense')).toBe('nonsense');
    expect(nextStreamId('1700000000000-x')).toBe('1700000000000-x');
  });

  it('is strictly greater than the id it came from', () => {
    // the ordering XTRIM relies on: same ms, higher sequence
    const id = '1700000000000-5';
    const next = nextStreamId(id);
    const [ms, seq] = id.split('-').map(Number);
    const [nms, nseq] = next.split('-').map(Number);
    expect(nms).toBe(ms);
    expect(nseq).toBeGreaterThan(seq!);
  });
});

describe('spool entries keep their values', () => {
  it('bytes, dates and 64-bit integers come out as they went in', () => {
    const at = new Date('2026-03-04T05:06:07.891Z');
    const entry = {
      op: 'update' as const,
      cursor: '0/16B3748',
      row: { id: 1, raw: Buffer.from('00ff10', 'hex'), at, big: 9223372036854775807n, doc: { a: [1] } },
    };
    const out = decodeEntry(encodeEntry(entry));
    expect(out.op).toBe('update');
    expect(out.cursor).toBe('0/16B3748');
    expect(Buffer.isBuffer(out.row.raw)).toBe(true);
    expect((out.row.raw as Buffer).toString('hex')).toBe('00ff10');
    expect((out.row.at as Date).getTime()).toBe(at.getTime());
    expect(out.row.big).toBe(9223372036854775807n);
    expect(out.row.doc).toEqual({ a: [1] });
  });

  it('plain JSON would have turned those bytes into an object', () => {
    // the behaviour being replaced, kept here as the reason for the codec
    const naive = JSON.parse(JSON.stringify({ raw: Buffer.from('ff', 'hex') }));
    expect(naive.raw).toEqual({ type: 'Buffer', data: [255] });
  });

  it('still reads an entry that was spooled before the codec existed', () => {
    // an upgrade must not strand changes already sitting in Redis
    const legacy = JSON.stringify({ op: 'insert', cursor: 'c1', row: { id: 7, name: 'a' } });
    expect(decodeEntry(legacy)).toEqual({ op: 'insert', cursor: 'c1', row: { id: 7, name: 'a' } });
  });

  it('rejects an entry with no row rather than delivering nothing as something', () => {
    expect(() => decodeEntry(JSON.stringify({ op: 'insert', cursor: 'c' }))).toThrow(/no row/);
    expect(() => decodeEntry('not json')).toThrow();
  });
});
