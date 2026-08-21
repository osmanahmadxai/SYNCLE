import { describe, expect, it } from 'vitest';
import { readSetupTokenFromHash, setupUrl } from './setup-token';

describe('readSetupTokenFromHash', () => {
  it('reads the token the launcher writes', () => {
    expect(readSetupTokenFromHash('#setup-token=4_jtNf95xrP5')).toBe(
      '4_jtNf95xrP5',
    );
  });

  it('works without the leading hash', () => {
    expect(readSetupTokenFromHash('setup-token=abc123')).toBe('abc123');
  });

  it('finds the token alongside other fragment params', () => {
    expect(readSetupTokenFromHash('#foo=1&setup-token=abc&bar=2')).toBe('abc');
    expect(readSetupTokenFromHash('#setup-token=abc&bar=2')).toBe('abc');
  });

  it('decodes percent-escapes', () => {
    // base64url never produces these, but the value is URL-encoded on the way in
    expect(readSetupTokenFromHash('#setup-token=a%2Bb%2Fc')).toBe('a+b/c');
  });

  it('survives a malformed escape instead of throwing', () => {
    // decodeURIComponent('%E0%A4%A') throws — the screen must still render
    expect(readSetupTokenFromHash('#setup-token=%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('returns null when there is no token', () => {
    expect(readSetupTokenFromHash('')).toBeNull();
    expect(readSetupTokenFromHash('#')).toBeNull();
    expect(readSetupTokenFromHash('#other=1')).toBeNull();
    expect(readSetupTokenFromHash('#setup-token=')).toBeNull();
  });

  it('does not match a key that merely ends with the param name', () => {
    expect(readSetupTokenFromHash('#not-setup-token=abc')).toBeNull();
  });

  it('ignores surrounding whitespace', () => {
    expect(readSetupTokenFromHash('#setup-token=%20abc%20')).toBe('abc');
    expect(readSetupTokenFromHash('#setup-token=%20')).toBeNull();
  });
});

describe('setupUrl', () => {
  it('builds the URL the launcher opens', () => {
    expect(setupUrl('http://localhost:3002', 'abc')).toBe(
      'http://localhost:3002/#setup-token=abc',
    );
  });

  it('does not double the slash', () => {
    expect(setupUrl('http://localhost:3002/', 'abc')).toBe(
      'http://localhost:3002/#setup-token=abc',
    );
  });

  it('round-trips a token through the fragment', () => {
    const token = 'a+b/c=';
    const url = setupUrl('http://localhost:3002', token);
    expect(readSetupTokenFromHash(new URL(url).hash)).toBe(token);
  });
});
