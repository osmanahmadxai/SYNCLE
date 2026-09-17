/**
 * what every page of the web app says about itself.
 *
 * the Content-Security-Policy allows what this app serves and nothing else: no
 * script, style, font or worker from anywhere but its own origin (the query
 * editor is served from /monaco for exactly that reason), connections only to
 * itself — and to the API, where NEXT_PUBLIC_API_URL points the browser at it
 * directly — and no page may frame it.
 *
 * 'unsafe-inline' for scripts is what it honestly is: Next.js hydrates through
 * inline scripts, and a nonce for them means rendering every page per request.
 * what the policy still takes away is loading script from ANOTHER origin,
 * plugins, a re-based document, forms posting elsewhere, and being framed.
 */

/** @param {{ apiUrl?: string, dev?: boolean }} opts */
export function contentSecurityPolicy({ apiUrl, dev = false } = {}) {
  let api = '';
  try {
    // an absolute API URL: the browser talks to the API itself, cross-origin
    if (apiUrl && /^https?:\/\//i.test(apiUrl))
      api = ` ${new URL(apiUrl).origin}`;
  } catch {
    api = '';
  }
  return [
    "default-src 'self'",
    // (the dev server evaluates and hot-reloads over a websocket; a build does neither)
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // the editor starts its language workers from blobs it builds itself
    "worker-src 'self' blob:",
    `connect-src 'self'${api}${dev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** @param {{ apiUrl?: string, dev?: boolean }} opts */
export function securityHeaders(opts = {}) {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(opts) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ];
}
