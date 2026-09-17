import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  securityHeaders,
} from '../security-headers.mjs';

const directives = (csp: string): Record<string, string[]> =>
  Object.fromEntries(
    csp.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]),
  );

describe('the Content-Security-Policy', () => {
  it('a build loads script, style, fonts and workers from the app itself and nowhere else', () => {
    const csp = directives(contentSecurityPolicy());
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp['worker-src']).toEqual(["'self'", 'blob:']);
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    // no CDN anywhere: the query editor is served from /monaco
    expect(contentSecurityPolicy()).not.toMatch(/https?:|\*/);
  });

  it('the browser may talk to the API directly only where it was built to', () => {
    expect(
      directives(
        contentSecurityPolicy({ apiUrl: 'https://api.example.com/api' }),
      )['connect-src'],
    ).toEqual(["'self'", 'https://api.example.com']);
    // relative, empty, or nonsense: the app's own origin only
    for (const apiUrl of [
      '/api',
      '',
      undefined,
      'not a url',
      'javascript:alert(1)',
    ]) {
      expect(
        directives(contentSecurityPolicy({ apiUrl }))['connect-src'],
      ).toEqual(["'self'"]);
    }
  });

  it('only the dev server may evaluate and open a websocket', () => {
    const dev = directives(contentSecurityPolicy({ dev: true }));
    expect(dev['script-src']).toContain("'unsafe-eval'");
    expect(dev['connect-src']).toEqual(["'self'", 'ws:', 'wss:']);
    expect(contentSecurityPolicy({ dev: false })).not.toContain('unsafe-eval');
  });
});

describe('every page', () => {
  it('cannot be framed, is not sniffed, and asks for no device it has no use for', () => {
    const headers = Object.fromEntries(
      securityHeaders().map((h) => [h.key, h.value]),
    );
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toMatch(
      /camera=\(\).*microphone=\(\).*geolocation=\(\)/,
    );
    expect(headers['Content-Security-Policy']).toBe(contentSecurityPolicy());
  });
});
