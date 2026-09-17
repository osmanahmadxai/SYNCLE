import { describe, expect, it } from 'vitest';
import { ALERT_EVENT_TYPES, alertChannelInputSchema } from './alerts';

const base = { name: 'Ops', events: ['bridge.failed'] };

describe('alertChannelInputSchema', () => {
  it('takes the three kinds, with their defaults', () => {
    expect(
      alertChannelInputSchema.parse({
        ...base,
        kind: 'webhook',
        url: 'https://example.com/hook',
      }),
    ).toMatchObject({
      kind: 'webhook',
      enabled: true,
    });
    expect(
      alertChannelInputSchema.parse({
        ...base,
        kind: 'slack',
        url: 'https://hooks.slack.com/services/T/B/x',
      }).kind,
    ).toBe('slack');
    const mail = alertChannelInputSchema.parse({
      ...base,
      kind: 'email',
      smtp: { host: 'smtp.example.com' },
      from: 'syncle@example.com',
      to: ['ops@example.com'],
    });
    expect(mail).toMatchObject({ smtp: { port: 587, secure: false } });
  });

  it('refuses a URL that is not http(s): a channel is a place requests are sent to', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(
        alertChannelInputSchema.safeParse({ ...base, kind: 'webhook', url })
          .success,
        url,
      ).toBe(false);
      expect(
        alertChannelInputSchema.safeParse({ ...base, kind: 'slack', url })
          .success,
        url,
      ).toBe(false);
    }
  });

  it('refuses a channel that would never say anything, or an event it does not know', () => {
    const hook = { kind: 'webhook', name: 'x', url: 'https://example.com' };
    expect(
      alertChannelInputSchema.safeParse({ ...hook, events: [] }).success,
    ).toBe(false);
    expect(
      alertChannelInputSchema.safeParse({
        ...hook,
        events: ['bridge.exploded'],
      }).success,
    ).toBe(false);
    // `test` is something a channel is sent, not something it subscribes to
    expect(
      alertChannelInputSchema.safeParse({ ...hook, events: ['test'] }).success,
    ).toBe(false);
    expect(
      alertChannelInputSchema.safeParse({
        ...hook,
        events: [...ALERT_EVENT_TYPES],
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown kind, a nameless channel, and addresses that are not addresses', () => {
    expect(
      alertChannelInputSchema.safeParse({
        ...base,
        kind: 'pager',
        url: 'https://x.test',
      }).success,
    ).toBe(false);
    expect(
      alertChannelInputSchema.safeParse({
        ...base,
        name: '  ',
        kind: 'slack',
        url: 'https://x.test',
      }).success,
    ).toBe(false);
    const mail = {
      ...base,
      kind: 'email',
      smtp: { host: 'h' },
      from: 'a@b.co',
    };
    expect(alertChannelInputSchema.safeParse({ ...mail, to: [] }).success).toBe(
      false,
    );
    expect(
      alertChannelInputSchema.safeParse({ ...mail, to: ['nobody'] }).success,
    ).toBe(false);
    expect(
      alertChannelInputSchema.safeParse({
        ...mail,
        to: ['ops@example.com'],
        from: 'nope',
      }).success,
    ).toBe(false);
    expect(
      alertChannelInputSchema.safeParse({
        ...mail,
        to: ['ops@example.com'],
        smtp: { host: 'h', port: 70000 },
      }).success,
    ).toBe(false);
  });
});
