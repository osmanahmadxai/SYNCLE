import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiKeyInfo } from '@syncle/core';
import { queryKeys } from '@/lib/queries';
import { ApiKeysSection, keyState } from './api-keys-section';

describe('whether a key still works', () => {
  const now = Date.parse('2026-09-17T10:00:00.000Z');
  it('active, revoked, expired — and a revoked key is revoked whatever its expiry says', () => {
    expect(keyState({ revokedAt: null, expiresAt: null }, now)).toBe('active');
    expect(
      keyState({ revokedAt: null, expiresAt: '2026-09-18T00:00:00.000Z' }, now),
    ).toBe('active');
    expect(
      keyState({ revokedAt: null, expiresAt: '2026-09-17T10:00:00.000Z' }, now),
    ).toBe('expired');
    expect(
      keyState(
        {
          revokedAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
        now,
      ),
    ).toBe('revoked');
  });
});

const key = (over: Partial<ApiKeyInfo>): ApiKeyInfo => ({
  id: 'k1',
  name: 'ci <script>',
  prefix: 'syn_a1b2c3d4',
  scope: 'read',
  createdAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

describe.each(['en', 'it', 'zh'])(
  'Settings › Security › API keys in %s',
  (locale) => {
    const messages = JSON.parse(
      readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
    ) as Record<string, never>;
    function render(keys: ApiKeyInfo[]): string {
      const client = new QueryClient();
      client.setQueryData(queryKeys.apiKeys, keys);
      const problems: string[] = [];
      const html = renderToStaticMarkup(
        <NextIntlClientProvider
          locale={locale}
          messages={messages}
          timeZone="UTC"
          onError={(e) => problems.push(e.message)}
        >
          <QueryClientProvider client={client}>
            <ApiKeysSection />
          </QueryClientProvider>
        </NextIntlClientProvider>,
      );
      expect(problems).toEqual([]);
      expect(html).not.toMatch(/apiKeys\.\w/);
      return html;
    }

    it('with no keys: the form, and nothing that looks like a key', () => {
      const html = render([]);
      expect(html).toContain('id="api-key-name"');
      expect(html).not.toContain('syn_');
    });

    it('lists keys by how they START — a key in every state, its name escaped', () => {
      const html = render([
        key({ id: 'a' }),
        key({
          id: 'b',
          scope: 'full',
          lastUsedAt: '2026-09-16T00:00:00.000Z',
          expiresAt: '2030-01-01T00:00:00.000Z',
        }),
        key({ id: 'c', revokedAt: '2026-09-10T00:00:00.000Z' }),
        key({ id: 'd', expiresAt: '2020-01-01T00:00:00.000Z' }),
      ]);
      // (server rendering puts a comment between two adjacent pieces of text)
      expect(html.match(/syn_a1b2c3d4/g)).toHaveLength(4);
      expect(html).toContain('ci &lt;script&gt;');
      // the two that no longer work are crossed out, and cannot be revoked again
      expect(html.match(/line-through/g)).toHaveLength(2);
      expect(
        html.match(
          /<button[^>]*aria-label="[^"]+"[^>]*>\s*<svg[^>]*lucide-trash/g,
        ),
      ).toHaveLength(2);
    });
  },
);
