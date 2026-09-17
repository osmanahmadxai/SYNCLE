import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AlertEvent } from '@syncle/core';
import {
  emailSubject,
  emailText,
  signBody,
  slackBody,
  slackEscape,
  webhookBody,
} from './alert-messages';

const event: AlertEvent = {
  type: 'bridge.failed',
  severity: 'critical',
  title: 'Bridge "orders → warehouse" stopped',
  message: 'Paused after a failed delivery (onError=abort): duplicate key',
  bridgeId: 'b-1',
  bridgeName: 'orders → warehouse',
  jobId: 'j-1',
  at: '2026-09-17T10:00:00.000Z',
};

describe('what a webhook receives', () => {
  it('is the event, and which Syncle sent it', () => {
    expect(JSON.parse(webhookBody(event, '1.3.0'))).toEqual({
      app: 'syncle',
      version: '1.3.0',
      ...event,
    });
  });

  it('is signed over the exact bytes that are sent', () => {
    const body = webhookBody(event, '1.3.0');
    const expected = createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(signBody(body, 's3cret')).toBe(`sha256=${expected}`);
    expect(signBody(`${body} `, 's3cret')).not.toBe(`sha256=${expected}`);
    expect(signBody(body, 'other')).not.toBe(`sha256=${expected}`);
  });
});

describe('what Slack receives', () => {
  it('cannot be made to page a channel by a bridge’s name', () => {
    expect(slackEscape('<!channel> & <@U123>')).toBe(
      '&lt;!channel&gt; &amp; &lt;@U123&gt;',
    );
    const body = slackBody({
      ...event,
      title: 'Bridge "<!here>" stopped',
      bridgeName: '<!here>',
    });
    expect(JSON.stringify(body)).not.toContain('<!here>');
    expect(JSON.stringify(body)).toContain('&lt;!here&gt;');
  });

  it('says how bad it is, what happened, and what was held back', () => {
    const critical = slackBody({ ...event, suppressed: 4 });
    expect(critical.text).toBe(
      ':red_circle: Bridge "orders → warehouse" stopped',
    );
    expect(JSON.stringify(critical.blocks)).toContain(
      '4 more like this were not sent',
    );
    expect(slackBody({ ...event, severity: 'warning' }).text).toMatch(
      /^:warning:/,
    );
    expect(slackBody({ ...event, type: 'test' }).text).toMatch(
      /^:white_check_mark:/,
    );
  });

  it('cuts an error that is a page long', () => {
    const body = slackBody({ ...event, message: 'x'.repeat(10_000) });
    expect(JSON.stringify(body).length).toBeLessThan(3_500);
  });
});

describe('what an e-mail says', () => {
  it('has a subject that is ONE line, whatever the bridge is called', () => {
    const subject = emailSubject({
      ...event,
      title: 'Bridge "a\r\nBcc: everyone@example.com" stopped',
    });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject.startsWith('[Syncle] ')).toBe(true);
    expect(
      emailSubject({ ...event, title: 'y'.repeat(500) }).length,
    ).toBeLessThanOrEqual(200);
  });

  it('carries what is needed to find the bridge, and nothing that is not there', () => {
    const text = emailText(event);
    expect(text).toContain('Bridge:    orders → warehouse (b-1)');
    expect(text).toContain('Job:       j-1');
    expect(text).toContain('Event:     bridge.failed (critical)');
    const bare = emailText({
      type: 'test',
      severity: 'warning',
      title: 't',
      message: 'm',
      at: event.at,
    });
    expect(bare).not.toContain('Bridge:');
    expect(bare).not.toContain('Job:');
    expect(emailText({ ...event, suppressed: 1 })).toContain(
      '1 more alert like this one',
    );
  });
});
