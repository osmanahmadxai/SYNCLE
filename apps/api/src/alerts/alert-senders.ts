/**
 * one alert, to one channel. resolves with how it went — it does not throw: a
 * receiver that is down is an outcome to record, not an error to handle.
 */
import { createTransport } from 'nodemailer';
import type { AlertEvent, AlertTestResult } from '@syncle/core';
import { assertAllowedDestination } from '../common/url-guard';
import type { StoredChannel } from './alert-channel.store';
import {
  emailSubject,
  emailText,
  signBody,
  slackBody,
  webhookBody,
} from './alert-messages';

const TIMEOUT_MS = 10_000;

export interface SenderDeps {
  version: string;
  fetch?: typeof fetch;
  /** replaced in tests: what nodemailer's `createTransport` is */
  createTransport?: typeof createTransport;
}

async function post(
  deps: SenderDeps,
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<AlertTestResult> {
  // the same rule a bridge's HTTP destination is held to: never a cloud
  // metadata endpoint, and private ranges only where the operator allows them
  await assertAllowedDestination(url);
  const res = await (deps.fetch ?? fetch)(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': `Syncle/${deps.version}`,
      ...headers,
    },
    body,
    // a public host that redirects to an internal one would walk around the check above
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = (await res.text().catch(() => '')).slice(0, 300);
  return res.status >= 200 && res.status < 300
    ? { ok: true, detail: `HTTP ${res.status}` }
    : { ok: false, detail: `HTTP ${res.status}${text ? `: ${text}` : ''}` };
}

export async function sendAlert(
  channel: StoredChannel,
  event: AlertEvent,
  deps: SenderDeps,
): Promise<AlertTestResult> {
  try {
    switch (channel.kind) {
      case 'webhook': {
        const body = webhookBody(event, deps.version);
        return await post(deps, channel.url, body, {
          ...(channel.headers ?? {}),
          'x-syncle-event': event.type,
          ...(channel.secret
            ? { 'x-syncle-signature': signBody(body, channel.secret) }
            : {}),
        });
      }
      case 'slack':
        return await post(
          deps,
          channel.url,
          JSON.stringify(slackBody(event)),
          {},
        );
      case 'email': {
        const transport = (deps.createTransport ?? createTransport)({
          host: channel.smtp.host,
          port: channel.smtp.port,
          secure: channel.smtp.secure,
          ...(channel.smtp.user
            ? {
                auth: {
                  user: channel.smtp.user,
                  pass: channel.smtp.password ?? '',
                },
              }
            : {}),
          connectionTimeout: TIMEOUT_MS,
          greetingTimeout: TIMEOUT_MS,
          socketTimeout: TIMEOUT_MS,
          // the alert's content comes from bridge names and error texts: nothing
          // in it may make the mailer read a file or fetch a URL
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        try {
          const info = await transport.sendMail({
            from: channel.from,
            to: channel.to,
            subject: emailSubject(event),
            text: emailText(event),
          });
          const refused = (info as { rejected?: unknown[] }).rejected ?? [];
          return refused.length
            ? {
                ok: false,
                detail: `The mail server refused: ${refused.map(String).join(', ')}`,
              }
            : { ok: true, detail: 'Accepted by the mail server' };
        } finally {
          transport.close();
        }
      }
    }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const cause = e.cause?.code ?? e.cause?.message;
    return {
      ok: false,
      detail:
        e.name === 'TimeoutError'
          ? `No answer within ${TIMEOUT_MS / 1000} s`
          : `${e.message}${cause ? ` (${cause})` : ''}`,
    };
  }
}
