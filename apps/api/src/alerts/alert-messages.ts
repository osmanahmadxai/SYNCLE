/**
 * an alert as each kind of channel is told it. pure: the same event in, the
 * same bytes out — which is what lets a webhook's signature be checked, and
 * these be tested without a network.
 */
import { createHmac } from 'node:crypto';
import type { AlertEvent } from '@syncle/core';

/** what a webhook receives: the event, and which Syncle sent it */
export function webhookBody(event: AlertEvent, version: string): string {
  return JSON.stringify({ app: 'syncle', version, ...event });
}

/** `sha256=<hex>` of the exact body bytes under the channel's secret */
export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/** Slack reads `<`, `>` and `&` as markup: a bridge named `<!channel>` must not page one */
export function slackEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function slackBody(event: AlertEvent): {
  text: string;
  blocks: unknown[];
} {
  const icon =
    event.type === 'test'
      ? ':white_check_mark:'
      : event.severity === 'critical'
        ? ':red_circle:'
        : ':warning:';
  const title = slackEscape(event.title);
  const context = [
    event.bridgeName ? `bridge *${slackEscape(event.bridgeName)}*` : null,
    event.type,
    event.at,
    event.suppressed
      ? `${event.suppressed} more like this were not sent`
      : null,
  ].filter(Boolean);
  return {
    // what a notification shows, and what a client without blocks falls back to
    text: `${icon} ${title}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${icon} *${title}*\n${slackEscape(clip(event.message, 2500))}`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: context.join('  ·  ') }],
      },
    ],
  };
}

export function emailSubject(event: AlertEvent): string {
  // a header is one line: a bridge name is somebody's free text
  return clip(`[Syncle] ${event.title}`.replace(/[\r\n]+/g, ' '), 200);
}

export function emailText(event: AlertEvent): string {
  return [
    event.title,
    '',
    event.message,
    '',
    event.bridgeName
      ? `Bridge:    ${event.bridgeName}${event.bridgeId ? ` (${event.bridgeId})` : ''}`
      : null,
    event.jobId ? `Job:       ${event.jobId}` : null,
    `Event:     ${event.type} (${event.severity})`,
    `At:        ${event.at}`,
    event.suppressed
      ? `\n${event.suppressed} more alert${event.suppressed === 1 ? '' : 's'} like this one were not sent since the last.`
      : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
