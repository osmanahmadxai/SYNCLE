import { describe, expect, it, vi } from 'vitest';
import {
  originAllowed,
  originOf,
  requestOrigin,
  sameOriginOnly,
  securityHeaders,
} from './security';

describe('originOf', () => {
  it('is the scheme, host and port — and nothing for what is not a web origin', () => {
    expect(originOf('https://app.example.com/some/path?x=1')).toBe(
      'https://app.example.com',
    );
    expect(originOf('http://localhost:3002')).toBe('http://localhost:3002');
    expect(originOf('https://APP.example.com:443')).toBe(
      'https://app.example.com',
    );
    for (const junk of [
      '',
      'null',
      'app.example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      undefined,
      null,
    ])
      expect(originOf(junk)).toBeNull();
  });
});

describe('where the browser says a request was made', () => {
  const req = (protocol: string, headers: Record<string, string | string[]>) =>
    ({ protocol, headers }) as never;

  it('is what the proxies in front say it was: the web app sets both headers', () => {
    expect(
      requestOrigin(
        req('https', {
          host: 'api:4000',
          'x-forwarded-host': 'syncle.example.com',
        }),
      ),
    ).toBe('https://syncle.example.com');
    expect(requestOrigin(req('http', { host: '192.168.1.20:3002' }))).toBe(
      'http://192.168.1.20:3002',
    );
    // a chain of proxies: the first is the one the browser talked to
    expect(
      requestOrigin(
        req('https', { 'x-forwarded-host': 'syncle.example.com, internal-lb' }),
      ),
    ).toBe('https://syncle.example.com');
    expect(requestOrigin(req('http', {}))).toBeNull();
  });
});

describe('may a request from this origin change things?', () => {
  const own = 'https://syncle.example.com';
  const allowed = ['http://localhost:3002', 'https://ops.example.com/'];

  it('no Origin at all is not a browser: forgery is something a browser is tricked into', () => {
    expect(originAllowed(undefined, own, allowed)).toBe(true);
  });

  it('the app itself, and what WEB_ORIGIN names', () => {
    expect(originAllowed('https://syncle.example.com', own, allowed)).toBe(
      true,
    );
    expect(originAllowed('http://localhost:3002', own, allowed)).toBe(true);
    expect(originAllowed('https://ops.example.com', own, allowed)).toBe(true);
  });

  it('not a sibling subdomain, not another port or scheme, not "null", not a lookalike', () => {
    for (const origin of [
      'https://evil.example.com',
      'https://syncle.example.com.evil.test',
      'http://syncle.example.com',
      'https://syncle.example.com:8443',
      'null',
      '',
      'https://evil.test/https://syncle.example.com',
    ]) {
      expect(originAllowed(origin, own, allowed)).toBe(false);
    }
  });
});

function response() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return { res, headers };
}

describe('sameOriginOnly', () => {
  const guard = sameOriginOnly(() => ['http://localhost:3002']);
  const req = (method: string, origin?: string) =>
    ({
      method,
      protocol: 'https',
      headers: {
        host: 'syncle.example.com',
        ...(origin === undefined ? {} : { origin }),
      },
    }) as never;

  it('reading is never refused: a GET changes nothing', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      const next = vi.fn();
      guard(req(method, 'https://evil.test'), response().res as never, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('changing something from another site is refused before it reaches a route, in the API’s own error shape', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const next = vi.fn();
      const { res } = response();
      guard(req(method, 'https://evil.test'), res as never, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({
        error: {
          code: 'FORBIDDEN',
          details: { reason: 'cross-origin' },
          message: expect.stringMatching(
            /another site \(https:\/\/evil\.test\).*WEB_ORIGIN/,
          ),
        },
      });
    }
  });

  it('the browser’s own word — Sec-Fetch-Site — is believed first: it survives a proxy that rewrites Host', () => {
    // behind such a proxy the API thinks it is http://127.0.0.1:3002, and the browser knows better
    const behindProxy = (site: string | undefined, origin: string) =>
      ({
        method: 'POST',
        protocol: 'http',
        headers: {
          host: '127.0.0.1:3002',
          origin,
          ...(site ? { 'sec-fetch-site': site } : {}),
        },
      }) as never;
    const passes = (request: never) => {
      const next = vi.fn();
      guard(request, response().res as never, next);
      return next.mock.calls.length === 1;
    };
    expect(
      passes(behindProxy('same-origin', 'https://syncle.example.com')),
    ).toBe(true);
    expect(passes(behindProxy('none', 'https://syncle.example.com'))).toBe(
      true,
    );
    // a sibling subdomain is the same SITE and not the same origin; another site is neither
    expect(passes(behindProxy('same-site', 'https://evil.example.com'))).toBe(
      false,
    );
    expect(passes(behindProxy('cross-site', 'https://evil.test'))).toBe(false);
    // …unless that origin is one the operator named
    expect(passes(behindProxy('cross-site', 'http://localhost:3002'))).toBe(
      true,
    );
    // a browser too old to send it, behind that proxy: refused, and told what to set
    expect(passes(behindProxy(undefined, 'https://syncle.example.com'))).toBe(
      false,
    );
  });

  it('from the app, from a configured origin, or from no browser at all: passed on', () => {
    for (const origin of [
      'https://syncle.example.com',
      'http://localhost:3002',
      undefined,
    ]) {
      const next = vi.fn();
      guard(req('POST', origin), response().res as never, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});

describe('securityHeaders', () => {
  it('data is never markup, never framed, never cached — and HTTPS is asked for only where HTTPS was used', () => {
    const plain = response();
    securityHeaders(
      { secure: false } as never,
      plain.res as never,
      () => undefined,
    );
    expect(plain.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    expect(plain.headers['strict-transport-security']).toBeUndefined();
    const tls = response();
    securityHeaders(
      { secure: true } as never,
      tls.res as never,
      () => undefined,
    );
    expect(tls.headers['strict-transport-security']).toBe('max-age=15552000');
  });
});
