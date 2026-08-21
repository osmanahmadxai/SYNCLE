/**
 * Same-origin proxy to the Syncle API.
 *
 * The browser calls a relative `/api/...` on whatever origin served the page,
 * and this forwards it to the API from the server side. That keeps the API's
 * address out of the browser bundle, which is what makes a single published
 * Docker image work anywhere: `NEXT_PUBLIC_*` values are inlined at build
 * time, so an image built with `http://localhost:4002` would only ever work
 * for someone browsing from the machine running it — not from another device
 * on the network.
 *
 * It also means one exposed port instead of two, and no CORS: the browser
 * never talks to the API cross-origin.
 */
import type { NextRequest } from 'next/server';

/**
 * Where the API lives from the *server's* point of view — the compose stack
 * sets this to the service name, and locally it's the port `pnpm dev` uses.
 * Read at request time (not build time), so the same image adapts to its
 * environment.
 */
function apiOrigin(): string {
  const raw =
    process.env.SYNCLE_API_ORIGIN ??
    `http://127.0.0.1:${process.env.API_PORT ?? '4002'}`;
  return raw.replace(/\/+$/, '');
}

/**
 * Hop-by-hop headers are connection-scoped and must not be relayed. `host` is
 * dropped so fetch derives it from the target, and `content-length` because
 * the body is re-encoded here.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'host',
  'content-length',
]);

async function proxy(req: NextRequest): Promise<Response> {
  // the incoming pathname already carries the API's `/api` global prefix, so
  // it maps across untouched — and using it raw avoids re-encoding segments
  const target = `${apiOrigin()}${req.nextUrl.pathname}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  // the API decides whether to mark session cookies Secure from the scheme the
  // *browser* used; without this it would only ever see the proxy's plain HTTP
  const forwardedProto =
    req.headers.get('x-forwarded-proto') ??
    req.nextUrl.protocol.replace(':', '');
  headers.set('x-forwarded-proto', forwardedProto);
  const host = req.headers.get('host');
  if (host) headers.set('x-forwarded-host', host);

  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      // buffered rather than streamed: a streaming body would need
      // `duplex: 'half'` and undici still buffers for the sizes involved here
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (err) {
    // matches the API's error envelope so the client surfaces it as an ApiError
    return Response.json(
      {
        error: {
          code: 'NETWORK',
          message: 'Cannot reach the Syncle API.',
          details: (err as Error).message,
        },
      },
      { status: 503 },
    );
  }

  const resHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    // set-cookie is appended separately: forEach collapses repeats into one
    // comma-joined value, which corrupts cookies whose attributes contain commas
    if (k === 'set-cookie') return;
    // fetch has already decoded the body, so relaying the original
    // content-encoding would tell the browser to decompress it a second time
    if (k === 'content-encoding') return;
    if (!HOP_BY_HOP.has(k)) resHeaders.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    resHeaders.append('set-cookie', cookie);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

// never cached or statically evaluated — every call is a live API request
export const dynamic = 'force-dynamic';

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
  proxy as OPTIONS,
};
