/**
 * What every response says about itself, and which requests are taken from a
 * browser at all.
 *
 * The session is a cookie, and a cookie goes wherever the browser sends a
 * request — also one that another site made it send. `SameSite=Lax` stops most
 * of that, and not all: it does not know a sibling subdomain from the app
 * (both are the same SITE), and older browsers ignore it. So a request that
 * changes something has to come FROM the app: a browser says where a request
 * comes from in `Origin`, and a page cannot forge it.
 *
 *  - `Sec-Fetch-Site: same-origin` — the browser itself saying the request was
 *    made by a page of the app. every current browser sends it, no page can set
 *    it, and it does not depend on what a reverse proxy did to the Host header
 *    on the way (which is why it is asked first: an install behind a proxy that
 *    rewrites Host must not be locked out of itself by an upgrade)
 *  - no `Origin` at all: not a browser (curl, a script with an API key). Cross-
 *    site request forgery is something a browser is tricked into; nothing to do
 *  - an `Origin` that is the app's own, or one of WEB_ORIGIN: fine
 *  - anything else: refused, before it reaches a route
 *
 * No dependency for this: it is a dozen headers and one comparison.
 */
import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `https://app.example.com` of a URL-ish string; null when it is not one */
export function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * the origin the BROWSER used for this request, as far as the proxies in front
 * say: scheme from X-Forwarded-Proto (Express' `trust proxy`), host from
 * X-Forwarded-Host — the web app's own proxy sets both — or the Host header
 */
export function requestOrigin(
  req: Pick<Request, 'protocol' | 'headers'>,
): string | null {
  const forwarded = req.headers['x-forwarded-host'];
  const host =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(',')[0]
      ?.trim() || req.headers.host;
  return host ? originOf(`${req.protocol}://${host}`) : null;
}

/** may a request with this Origin change things? `allowed` are the configured web origins */
export function originAllowed(
  origin: string | undefined,
  own: string | null,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true; // not a browser
  const normalized = originOf(origin);
  // `Origin: null` is what a sandboxed frame or a redirected form sends: never the app
  if (!normalized) return false;
  if (own && normalized === own) return true;
  return allowed.some((candidate) => originOf(candidate) === normalized);
}

export function securityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // what this API returns is data: never markup to render, never something to frame
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'",
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  // connection details, rows of somebody's tables: not for a shared cache, or the back button of the next person
  res.setHeader('Cache-Control', 'no-store');
  // only over HTTPS, as the browser saw it: over plain HTTP the header is ignored anyway, and on a LAN address it would be wrong
  if (req.secure)
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

export function sameOriginOnly(allowed: () => readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return next();
    // the browser's own word for it. (`none` is a request the user made
    // directly — an address typed, a bookmark — not one a page made)
    const site = req.headers['sec-fetch-site'];
    if (site === 'same-origin' || site === 'none') return next();
    const origin = req.headers.origin;
    if (originAllowed(origin, requestOrigin(req), allowed())) return next();
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message:
          `This request came from another site (${String(origin)}) and was refused. ` +
          'If that is where Syncle is opened from, add it to WEB_ORIGIN.',
        details: { reason: 'cross-origin' },
      },
    });
  };
}
