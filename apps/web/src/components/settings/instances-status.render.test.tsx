/**
 * the settings dialog's "API processes" panel, in every language: silent for the
 * one process almost every installation has; and saying what matters when there
 * are several, when nobody leads, and when they are not the same version.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InstanceInfo } from '@/lib/api';
import { InstancesReport } from './instances-status';

const messagesOf = (locale: string) =>
  JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as Record<string, never>;

function render(locale: string, instances: InstanceInfo[]): string {
  const problems: string[] = [];
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messagesOf(locale)}
      timeZone="UTC"
      onError={(e) => problems.push(e.message)}
    >
      <InstancesReport instances={instances} />
    </NextIntlClientProvider>,
  );
  expect(problems).toEqual([]);
  expect(html).not.toMatch(/settingsDialog\.\w/);
  return html;
}

const one = (over: Partial<InstanceInfo>): InstanceInfo => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000000',
  startedAt: '2026-09-18T08:00:00.000Z',
  version: '1.3.0',
  leader: true,
  self: true,
  ...over,
});
const other = one({
  id: 'bbbbbbbb-0000-4000-8000-000000000000',
  startedAt: '2026-09-18T09:30:00.000Z',
  leader: false,
  self: false,
});

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  const m = (
    messagesOf(locale) as unknown as {
      settingsDialog: { instances: Record<string, string> };
    }
  ).settingsDialog.instances;

  it('one process that leads: nothing to say, nothing shown', () => {
    expect(render(locale, [one({})])).toBe('');
    expect(render(locale, [])).toBe('');
  });

  it('two: who they are, which one leads, which one answered', () => {
    const html = render(locale, [one({}), other]);
    expect(html).toContain('aaaaaaaa');
    expect(html).toContain('bbbbbbbb');
    // one leader, marked once (the word is in the explanation too: the MARK is looked for)
    expect(html.split(`>${m.leader!}</span>`)).toHaveLength(2);
    expect(html).toContain(m.self!);
    expect(html).toContain('SYNCLE_LEADER_TTL_SECONDS');
    expect(html).not.toContain('role="alert"');
  });

  it('nobody leads — even with ONE process — is said, because no live bridge is being read', () => {
    const html = render(locale, [one({ leader: false })]);
    expect(html).toContain('role="alert"');
    expect(html).toContain(m.leaderless!.slice(0, 12));
  });

  it('processes of different versions on one database are a warning', () => {
    const html = render(locale, [one({}), { ...other, version: '1.2.0' }]);
    expect(html).toContain('role="alert"');
    expect(html).toContain('v1.2.0');
    expect(html).toContain(m.versions!.slice(0, 10));
  });
});
