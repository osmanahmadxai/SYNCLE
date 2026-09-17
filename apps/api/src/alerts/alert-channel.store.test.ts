import { describe, expect, it } from 'vitest';
import {
  ALERT_SECRET_SENTINEL as S,
  type AlertChannelInput,
} from '@syncle/core';
import {
  assertNoMaskLeft,
  maskUrl,
  mergeSecrets,
  redact,
} from './alert-channel.store';

const webhook: AlertChannelInput = {
  kind: 'webhook',
  name: 'Ops',
  enabled: true,
  events: ['bridge.failed'],
  url: 'https://example.com/hooks/abc?token=xyz',
  headers: { 'X-Api-Key': 'k-123', 'X-Team': 'data' },
  secret: 'signing-secret',
};
const slack: AlertChannelInput = {
  kind: 'slack',
  name: 'Slack',
  enabled: true,
  events: ['bridge.failed'],
  url: 'https://hooks.slack.com/services/T000/B000/XXXX',
};
const mail: AlertChannelInput = {
  kind: 'email',
  name: 'Mail',
  enabled: true,
  events: ['bridge.failed'],
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'syncle',
    password: 'hunter2',
  },
  from: 'syncle@example.com',
  to: ['ops@example.com'],
};

describe('what may be shown of a channel', () => {
  it('a URL keeps its origin — enough to recognise it — and nothing after', () => {
    expect(maskUrl('https://hooks.slack.com/services/T000/B000/XXXX')).toBe(
      `https://hooks.slack.com/${S}`,
    );
    expect(maskUrl('https://example.com/hook?token=xyz')).toBe(
      `https://example.com/${S}`,
    );
    expect(maskUrl('https://example.com')).toBe('https://example.com');
    expect(maskUrl('https://example.com/')).toBe('https://example.com');
    expect(maskUrl('nonsense')).toBe(S);
  });

  it('never the token in a URL, a header’s value, a signing secret or a password', () => {
    for (const channel of [webhook, slack, mail]) {
      const shown = JSON.stringify(redact(channel));
      for (const secret of [
        'xyz',
        'abc',
        'k-123',
        'signing-secret',
        'XXXX',
        'T000',
        'hunter2',
      ]) {
        expect(shown, `${channel.kind}: ${secret}`).not.toContain(secret);
      }
    }
    // what is not a secret stays: header NAMES, the SMTP host and user, the addresses
    expect(redact(webhook)).toMatchObject({
      headers: { 'X-Api-Key': S, 'X-Team': S },
    });
    expect(redact(mail)).toMatchObject({
      smtp: { host: 'smtp.example.com', user: 'syncle', password: S },
      to: ['ops@example.com'],
    });
  });

  it('does not invent a secret that was never set', () => {
    // as the API returns it: a form shown "••••••••" for a secret that does not
    // exist would send it back, and it would then be stored as the secret
    const plain = JSON.parse(
      JSON.stringify(
        redact({ ...webhook, secret: undefined, headers: undefined }),
      ),
    );
    expect(plain).not.toHaveProperty('secret');
    expect(plain).not.toHaveProperty('headers');
    const noPassword = JSON.parse(
      JSON.stringify(
        redact({ ...mail, smtp: { ...mail.smtp, password: undefined } }),
      ),
    );
    expect(noPassword).not.toHaveProperty('smtp.password');
  });
});

describe('an update that sends back what it was shown', () => {
  it('keeps what is stored, field by field', () => {
    const shown = redact(webhook) as typeof webhook;
    expect(mergeSecrets({ ...shown, name: 'Renamed' }, webhook)).toEqual({
      ...webhook,
      name: 'Renamed',
    });
    expect(mergeSecrets(redact(slack), slack)).toEqual(slack);
    expect(mergeSecrets(redact(mail), mail)).toEqual(mail);
  });

  it('takes what was actually typed', () => {
    const next = mergeSecrets(
      {
        ...(redact(webhook) as typeof webhook),
        url: 'https://new.example.com/h',
        secret: 'rotated',
        headers: { 'X-Api-Key': S, 'X-New': 'v' },
      },
      webhook,
    );
    expect(next).toMatchObject({
      url: 'https://new.example.com/h',
      secret: 'rotated',
      // kept, because it came back masked; added, because it is new; gone, because it was removed
      headers: { 'X-Api-Key': 'k-123', 'X-New': 'v' },
    });
  });

  it('clears a secret that is sent back empty', () => {
    expect(
      mergeSecrets(
        { ...(redact(webhook) as typeof webhook), secret: undefined },
        webhook,
      ),
    ).toMatchObject({ secret: undefined });
  });

  it('keeps nothing across a change of kind, and nothing when there was nothing', () => {
    const asSlack = { ...slack, url: `https://hooks.slack.com/${S}` };
    // the masked URL is all there is: it must not be "restored" from a webhook's
    expect(mergeSecrets(asSlack, webhook)).toEqual(asSlack);
    expect(mergeSecrets(asSlack, null)).toEqual(asSlack);
  });

  it('a masked header that was never stored stays what it is — and is not a way to read another one', () => {
    const next = mergeSecrets(
      { ...(redact(webhook) as typeof webhook), headers: { 'X-Other': S } },
      webhook,
    );
    expect((next as typeof webhook).headers).toEqual({ 'X-Other': S });
    // …which is then refused, not stored as a header whose value is eight dots
    expect(() => assertNoMaskLeft(next)).toThrow(/the header "X-Other"/);
  });

  it('a mask with nothing behind it is refused: a new channel, or another kind, sent with the dots still in it', () => {
    expect(() => assertNoMaskLeft(redact(webhook))).toThrow(
      /the URL, the signing secret, the header "X-Api-Key"/,
    );
    expect(() => assertNoMaskLeft(redact(slack))).toThrow(/the URL/);
    expect(() => assertNoMaskLeft(redact(mail))).toThrow(/the SMTP password/);
    // what came through the merge with the real values back in place is fine
    for (const channel of [webhook, slack, mail]) {
      expect(() =>
        assertNoMaskLeft(mergeSecrets(redact(channel), channel)),
      ).not.toThrow();
    }
  });
});
