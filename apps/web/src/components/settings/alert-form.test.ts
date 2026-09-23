import { describe, expect, it } from 'vitest';
import {
  ALERT_EVENT_TYPES,
  ALERT_SECRET_SENTINEL as S,
  alertChannelInputSchema,
  type AlertChannel,
} from '@syncle/core';
import {
  ALERT_KINDS,
  alertFormOf,
  alertFormProblems,
  alertInputOf,
  blankAlertForm,
  validAlertInput,
} from './alert-form';

const meta = {
  id: 'c1',
  createdAt: '',
  updatedAt: '',
  lastStatus: null,
  lastError: null,
  lastSentAt: null,
} as const;

describe('a new channel', () => {
  it('listens for everything, is switched on — and cannot be saved as it is', () => {
    for (const kind of ALERT_KINDS) {
      const form = blankAlertForm(kind);
      expect(form.events).toEqual([...ALERT_EVENT_TYPES]);
      expect(form.enabled).toBe(true);
      expect(validAlertInput(form, { editing: false })).toBeNull();
    }
    expect(
      [
        ...alertFormProblems(blankAlertForm('webhook'), { editing: false }),
      ].sort(),
    ).toEqual(['name', 'url']);
    expect(
      [
        ...alertFormProblems(blankAlertForm('email'), { editing: false }),
      ].sort(),
    ).toEqual(['from', 'name', 'smtpHost', 'to']);
  });

  it('offers exactly the kinds the API takes', () => {
    const kinds = alertChannelInputSchema.options
      .map((o) => o.shape.kind.value)
      .sort();
    expect([...ALERT_KINDS].sort()).toEqual(kinds);
  });
});

describe('what the form sends', () => {
  it('a webhook: trimmed, with only the headers that have a name, and no empty secret', () => {
    const form = {
      ...blankAlertForm('webhook'),
      name: '  Ops  ',
      url: ' https://example.com/hook ',
      headers: [
        { key: ' X-Api-Key ', value: 'k' },
        { key: '  ', value: 'dropped' },
      ],
    };
    expect(validAlertInput(form, { editing: false })).toEqual({
      kind: 'webhook',
      name: 'Ops',
      enabled: true,
      events: [...ALERT_EVENT_TYPES],
      url: 'https://example.com/hook',
      headers: { 'X-Api-Key': 'k' },
    });
    expect(alertInputOf({ ...form, secret: 's' })).toMatchObject({
      secret: 's',
    });
  });

  it('an e-mail channel: recipients split on commas, spaces and new lines; the port as typed', () => {
    const form = {
      ...blankAlertForm('email'),
      name: 'Mail',
      smtpHost: 'smtp.example.com',
      smtpPort: '465',
      smtpSecure: true,
      from: 'syncle@example.com',
      to: 'ops@example.com, oncall@example.com\n  third@example.com;',
    };
    const input = validAlertInput(form, { editing: false });
    expect(input).toMatchObject({
      to: ['ops@example.com', 'oncall@example.com', 'third@example.com'],
      smtp: { host: 'smtp.example.com', secure: true },
    });
    // no user typed: no credentials sent, not an empty pair of them
    expect(input).not.toHaveProperty('smtp.user');
    expect(input).not.toHaveProperty('smtp.password');
    expect(alertChannelInputSchema.parse(input)).toMatchObject({
      smtp: { port: 465 },
    });
  });

  it('says which field is wrong, the way the API would', () => {
    const mail = {
      ...blankAlertForm('email'),
      name: 'M',
      smtpHost: 'h',
      from: 'a@b.co',
      to: 'ops@example.com',
    };
    expect([
      ...alertFormProblems({ ...mail, smtpPort: '70000' }, { editing: false }),
    ]).toEqual(['smtpPort']);
    expect([
      ...alertFormProblems(
        { ...mail, to: 'ops@example.com, nobody' },
        { editing: false },
      ),
    ]).toEqual(['to']);
    expect([
      ...alertFormProblems({ ...mail, from: 'nope' }, { editing: false }),
    ]).toEqual(['from']);
    const hook = {
      ...blankAlertForm('webhook'),
      name: 'H',
      url: 'https://example.com',
    };
    expect([
      ...alertFormProblems(
        { ...hook, url: 'ftp://example.com' },
        { editing: false },
      ),
    ]).toEqual(['url']);
    expect([
      ...alertFormProblems({ ...hook, events: [] }, { editing: false }),
    ]).toEqual(['events']);
    expect(alertFormProblems(hook, { editing: false }).size).toBe(0);
  });
});

describe('editing a stored channel', () => {
  const stored: AlertChannel = {
    ...meta,
    kind: 'webhook',
    name: 'Ops',
    enabled: false,
    events: ['bridge.failed'],
    url: `https://example.com/${S}`,
    secret: S,
    headers: { 'X-Api-Key': S },
  };

  it('shows what the API shows — masked — and sends it back as shown, for the server to put the real ones back', () => {
    const form = alertFormOf(stored);
    expect(form).toMatchObject({
      name: 'Ops',
      enabled: false,
      events: ['bridge.failed'],
      url: stored.url,
      secret: S,
    });
    expect(form.headers).toEqual([{ key: 'X-Api-Key', value: S }]);
    // a masked URL is not a URL, and is still fine: the server has the real one
    expect(alertFormProblems(form, { editing: true }).size).toBe(0);
    expect(validAlertInput(form, { editing: true })).toMatchObject({
      url: stored.url,
      secret: S,
      headers: { 'X-Api-Key': S },
    });
    // the same text on a NEW channel is just not a URL
    expect([...alertFormProblems(form, { editing: false })]).toEqual(['url']);
  });

  it('round-trips an e-mail channel', () => {
    const mail: AlertChannel = {
      ...meta,
      kind: 'email',
      name: 'Mail',
      enabled: true,
      events: ['source.hold'],
      smtp: {
        host: 'smtp.example.com',
        port: 2525,
        secure: false,
        user: 'u',
        password: S,
      },
      from: 'syncle@example.com',
      to: ['a@example.com', 'b@example.com'],
    };
    const form = alertFormOf(mail);
    expect(form).toMatchObject({
      smtpPort: '2525',
      smtpUser: 'u',
      smtpPassword: S,
      to: 'a@example.com, b@example.com',
    });
    expect(
      alertChannelInputSchema.parse(validAlertInput(form, { editing: true })),
    ).toEqual({
      kind: 'email',
      name: 'Mail',
      enabled: true,
      events: ['source.hold'],
      smtp: mail.smtp,
      from: mail.from,
      to: mail.to,
    });
  });
});
