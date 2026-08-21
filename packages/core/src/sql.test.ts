import { describe, expect, it } from 'vitest';
import { quoteIdent } from './sql';

describe('quoteIdent', () => {
  it('backtick-quotes for MySQL and escapes embedded backticks', () => {
    expect(quoteIdent('mysql', 'users')).toBe('`users`');
    expect(quoteIdent('mysql', 'we`ird')).toBe('`we``ird`');
  });

  it('double-quotes for the standard dialects and escapes embedded quotes', () => {
    expect(quoteIdent('postgres', 'User')).toBe('"User"');
    expect(quoteIdent('sqlite', 'or"der')).toBe('"or""der"');
  });
});
