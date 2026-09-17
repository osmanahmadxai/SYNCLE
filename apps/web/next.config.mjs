import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';
import { securityHeaders } from './security-headers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Wires up next-intl. Locale + messages are resolved per request in
// src/i18n/request.ts (cookie-based, no i18n routing).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Docker build sets NEXT_OUTPUT=standalone to emit the self-contained
  // server the runtime image ships; plain `next start` keeps working otherwise.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
  // The web app is a pure frontend; all data access goes through the NestJS
  // API. `@syncle/core` is consumed for shared types and Zod schemas only.
  transpilePackages: ['@syncle/core'],
  // Pin the monorepo root so Next doesn't pick up a stray lockfile elsewhere.
  outputFileTracingRoot: root,
  // Hide the floating Next.js dev indicator badge.
  devIndicators: false,
  // Don't leak the framework in response headers.
  poweredByHeader: false,
  // On every page and asset. (Responses of /api are the API's own, relayed with
  // the headers the API gave them: the proxy route sets those itself.)
  async headers() {
    return [
      {
        source: '/((?!api/).*)',
        headers: securityHeaders({
          apiUrl: process.env.NEXT_PUBLIC_API_URL,
          dev: process.env.NODE_ENV !== 'production',
        }),
      },
    ];
  },
};

export default withNextIntl(nextConfig);
