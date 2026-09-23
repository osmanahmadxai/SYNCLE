import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoginScreen } from './login-screen';
import { ResetPassword, resetProblem } from './reset-password';

describe('what stops a reset from being sent', () => {
  it('no code, a password that is too short, two that are not the same — in that order', () => {
    expect(
      resetProblem({
        code: '  ',
        password: 'long enough pw',
        confirm: 'long enough pw',
      }),
    ).toBe('code');
    expect(
      resetProblem({ code: 'abc', password: 'short', confirm: 'short' }),
    ).toBe('short');
    expect(
      resetProblem({
        code: 'abc',
        password: 'long enough pw',
        confirm: 'long enough pW',
      }),
    ).toBe('mismatch');
    expect(
      resetProblem({
        code: 'abc',
        password: 'long enough pw',
        confirm: 'long enough pw',
      }),
    ).toBeNull();
  });
});

describe.each(['en', 'it', 'zh'])('in %s', (locale) => {
  const messages = JSON.parse(
    readFileSync(join(__dirname, `../../messages/${locale}.json`), 'utf8'),
  ) as {
    auth: { login: Record<string, string>; reset: Record<string, string> };
  };
  const render = (element: React.ReactElement) => {
    const problems: string[] = [];
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={messages as never}
        timeZone="UTC"
        onError={(e) => problems.push(e.message)}
      >
        <QueryClientProvider client={new QueryClient()}>
          {element}
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    expect(problems).toEqual([]);
    expect(html).not.toMatch(/auth\.(login|reset)\.\w/);
    return html;
  };

  it('the login screen offers a way back in', () => {
    expect(render(<LoginScreen />)).toContain(messages.auth.login.forgot!);
  });

  it('first it says how this works and offers to print a code; nothing to type a code into yet', () => {
    const html = render(<ResetPassword onBack={() => undefined} />);
    expect(html).toContain(messages.auth.reset.ask!);
    expect(html).not.toContain('reset-code');
  });

  it('once asked: where the code is, and the form — a one-time code and a NEW password, as browsers should treat them', () => {
    const html = render(<ResetPassword onBack={() => undefined} requested />);
    expect(html).toContain('docker compose logs api');
    expect(html).toContain('one-time-code');
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
    expect(html.match(/type="password"/g)).toHaveLength(2);
  });
});
