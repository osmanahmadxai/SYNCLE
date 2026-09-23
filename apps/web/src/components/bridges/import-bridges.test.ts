import { describe, expect, it } from 'vitest';
import { fileSlug } from '@/lib/download';
import { readExport } from './import-bridges';

const document = {
  format: 'syncle.bridges',
  version: 1,
  exportedAt: '2026-09-17T10:00:00.000Z',
  connections: { c1: { name: 'prod', engine: 'postgres' } },
  bridges: [
    {
      name: 'users',
      source: { kind: 'table', connectionId: 'c1', table: 'users' },
      destination: { kind: 'http', url: 'https://example.com/hook' },
      transform: { template: '{{$row}}' },
    },
  ],
};

describe('reading a file someone picked', () => {
  it('takes an export, filling in what the schema defaults', () => {
    const read = readExport(JSON.stringify(document));
    expect('document' in read && read.document.bridges[0]).toMatchObject({
      name: 'users',
      trigger: { kind: 'replay' },
      destination: { method: 'POST', auth: { type: 'none' } },
    });
  });

  it('says which of two things is wrong with anything else', () => {
    expect(readExport('{ not json')).toEqual({ problem: 'not-json' });
    expect(readExport('')).toEqual({ problem: 'not-json' });
    expect(readExport('[]')).toEqual({ problem: 'not-an-export' });
    expect(
      readExport(JSON.stringify({ ...document, format: 'something.else' })),
    ).toEqual({ problem: 'not-an-export' });
    expect(readExport(JSON.stringify({ ...document, version: 2 }))).toEqual({
      problem: 'not-an-export',
    });
    expect(
      readExport(JSON.stringify({ ...document, bridges: [{ name: 'half' }] })),
    ).toEqual({ problem: 'not-an-export' });
  });
});

describe('a bridge’s name as a file name', () => {
  it('is nothing a file system or a shell would mind', () => {
    expect(fileSlug('Users → CRM (prod)')).toBe('Users-CRM-prod');
    expect(fileSlug('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(fileSlug('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(fileSlug('   ')).toBe('bridge');
    expect(fileSlug('x'.repeat(200))).toHaveLength(60);
  });
});
