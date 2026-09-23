import { describe, expect, it } from 'vitest';
import type { AlertEvent } from '@syncle/core';
import type { StoredChannel } from './alert-channel.store';
import { signBody } from './alert-messages';
import { sendAlert, type SenderDeps } from './alert-senders';

const event: AlertEvent = {
  type: 'bridge.failed',
  severity: 'critical',
  title: 'Bridge "orders" stopped',
  message: 'boom',
  bridgeId: 'b-1',
  bridgeName: 'orders',
  at: '2026-09-17T10:00:00.000Z',
};

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

function fakeFetch(answer: { status: number; body?: string } | Error): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    // (a 204 may not carry a body, not even an empty one)
    return new Response(answer.body ?? null, { status: answer.status });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const webhook: StoredChannel = {
  id: 'c1',
  kind: 'webhook',
  name: 'Ops',
  enabled: true,
  events: ['bridge.failed'],
  url: 'https://93.184.216.34/hook',
  headers: { 'X-Api-Key': 'k-123' },
  secret: 's3cret',
};

describe('a webhook', () => {
  it('gets the event as JSON, its own headers, the event’s type — and a signature of exactly those bytes', async () => {
    const { fetch, calls } = fakeFetch({ status: 204 });
    const result = await sendAlert(webhook, event, { version: '1.3.0', fetch });
    expect(result).toEqual({ ok: true, detail: 'HTTP 204' });
    const { url, init } = calls[0]!;
    expect(url).toBe('https://93.184.216.34/hook');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      app: 'syncle',
      version: '1.3.0',
      type: 'bridge.failed',
      bridgeId: 'b-1',
    });
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': 'Syncle/1.3.0',
      'X-Api-Key': 'k-123',
      'x-syncle-event': 'bridge.failed',
      'x-syncle-signature': signBody(String(init.body), 's3cret'),
    });
    // a redirect is not followed: it is how a public host points a request inwards
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('is not signed when it has no secret', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    await sendAlert({ ...webhook, secret: undefined }, event, {
      version: '1',
      fetch,
    });
    expect(calls[0]!.init.headers).not.toHaveProperty('x-syncle-signature');
  });

  it('that answers with anything but 2xx did NOT take it — a redirect included', async () => {
    for (const status of [301, 400, 500]) {
      const { fetch } = fakeFetch({ status, body: 'nope' });
      const result = await sendAlert(webhook, event, { version: '1', fetch });
      expect(result.ok, String(status)).toBe(false);
      expect(result.detail).toContain(`HTTP ${status}`);
    }
  });

  it('that cannot be reached is an outcome, not an exception', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    expect(
      await sendAlert(webhook, event, {
        version: '1',
        fetch: fakeFetch(refused).fetch,
      }),
    ).toEqual({
      ok: false,
      detail: 'fetch failed (ECONNREFUSED)',
    });
    const timeout = Object.assign(
      new Error('The operation was aborted due to timeout'),
      { name: 'TimeoutError' },
    );
    expect(
      (
        await sendAlert(webhook, event, {
          version: '1',
          fetch: fakeFetch(timeout).fetch,
        })
      ).detail,
    ).toBe('No answer within 10 s');
  });

  it('is never a cloud metadata endpoint: the request is not even made', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const result = await sendAlert(
      { ...webhook, url: 'http://169.254.169.254/latest/meta-data/' },
      event,
      { version: '1', fetch },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/metadata/i);
    expect(calls).toEqual([]);
  });
});

describe('Slack', () => {
  it('gets text and blocks, and no header of ours that could leak elsewhere', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: 'ok' });
    const slack: StoredChannel = {
      id: 'c2',
      kind: 'slack',
      name: 'S',
      enabled: true,
      events: ['bridge.failed'],
      url: 'https://93.184.216.34/services/T/B/X',
    };
    expect((await sendAlert(slack, event, { version: '1', fetch })).ok).toBe(
      true,
    );
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      text: string;
      blocks: unknown[];
    };
    expect(body.text).toContain('Bridge "orders" stopped');
    expect(body.blocks).toHaveLength(2);
    expect(calls[0]!.init.headers).not.toHaveProperty('x-syncle-signature');
  });
});

describe('e-mail', () => {
  const mail: StoredChannel = {
    id: 'c3',
    kind: 'email',
    name: 'Mail',
    enabled: true,
    events: ['bridge.failed'],
    smtp: {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'syncle',
      password: 'hunter2',
    },
    from: 'syncle@example.com',
    to: ['ops@example.com', 'oncall@example.com'],
  };

  function fakeTransport(answer: { rejected?: string[] } | Error) {
    const seen: {
      options?: Record<string, unknown>;
      message?: Record<string, unknown>;
      closed: number;
    } = { closed: 0 };
    const createTransport = ((options: Record<string, unknown>) => {
      seen.options = options;
      return {
        sendMail: async (message: Record<string, unknown>) => {
          seen.message = message;
          if (answer instanceof Error) throw answer;
          return { accepted: [], rejected: answer.rejected ?? [] };
        },
        close: () => {
          seen.closed++;
        },
      };
    }) as unknown as SenderDeps['createTransport'];
    return { createTransport, seen };
  }

  it('goes through the configured server, as plain text, with a mailer that may read no file and fetch no URL', async () => {
    const { createTransport, seen } = fakeTransport({});
    expect(
      await sendAlert(mail, event, { version: '1', createTransport }),
    ).toEqual({ ok: true, detail: 'Accepted by the mail server' });
    expect(seen.options).toMatchObject({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'syncle', pass: 'hunter2' },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(seen.message).toMatchObject({
      from: 'syncle@example.com',
      to: ['ops@example.com', 'oncall@example.com'],
      subject: '[Syncle] Bridge "orders" stopped',
    });
    expect(seen.message).not.toHaveProperty('html');
    expect(seen.closed).toBe(1);
  });

  it('sends no credentials to a server that was given none', async () => {
    const { createTransport, seen } = fakeTransport({});
    await sendAlert(
      { ...mail, smtp: { host: 'relay.internal', port: 25, secure: false } },
      event,
      { version: '1', createTransport },
    );
    expect(seen.options).not.toHaveProperty('auth');
  });

  it('a refused recipient, or a server that cannot be reached, did not take it — and the connection is closed either way', async () => {
    const refused = fakeTransport({ rejected: ['oncall@example.com'] });
    expect(
      await sendAlert(mail, event, {
        version: '1',
        createTransport: refused.createTransport,
      }),
    ).toEqual({
      ok: false,
      detail: 'The mail server refused: oncall@example.com',
    });
    const down = fakeTransport(new Error('connect ECONNREFUSED 10.0.0.1:465'));
    const result = await sendAlert(mail, event, {
      version: '1',
      createTransport: down.createTransport,
    });
    expect(result).toEqual({
      ok: false,
      detail: 'connect ECONNREFUSED 10.0.0.1:465',
    });
    expect(down.seen.closed).toBe(1);
  });
});
