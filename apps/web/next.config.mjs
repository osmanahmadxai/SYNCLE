import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Wires up next-intl. Locale + messages are resolved per request in
// src/i18n/request.ts (cookie-based, no i18n routing).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The web app is a pure frontend; all data access goes through the NestJS
  // API. `@syncle/core` is consumed for shared types and Zod schemas only.
  transpilePackages: ['@syncle/core'],
  // Pin the monorepo root so Next doesn't pick up a stray lockfile elsewhere.
  outputFileTracingRoot: root,
  // Hide the floating Next.js dev indicator badge.
  devIndicators: false,
  // Don't leak the framework in response headers.
  poweredByHeader: false,
};

export default withNextIntl(nextConfig);
