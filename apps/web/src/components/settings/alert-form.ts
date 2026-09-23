/**
 * the alert channel form, without React: what a blank one looks like, what a
 * stored one looks like in it, what it sends, and what is still wrong with it.
 * a form holds text; the API wants numbers, lists and absent optionals.
 */
import {
  ALERT_EVENT_TYPES,
  alertChannelInputSchema,
  type AlertChannel,
  type AlertChannelInput,
  type AlertChannelKind,
  type AlertEventType,
} from '@syncle/core';

export interface AlertForm {
  kind: AlertChannelKind;
  name: string;
  enabled: boolean;
  events: AlertEventType[];
  /** webhook + slack */
  url: string;
  /** webhook */
  secret: string;
  headers: Array<{ key: string; value: string }>;
  /** email */
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  from: string;
  /** comma- or newline-separated */
  to: string;
}

export const ALERT_KINDS: AlertChannelKind[] = ['webhook', 'slack', 'email'];

/** a new channel listens for everything: an alert nobody asked for is cheaper than one nobody got */
export function blankAlertForm(kind: AlertChannelKind = 'webhook'): AlertForm {
  return {
    kind,
    name: '',
    enabled: true,
    events: [...ALERT_EVENT_TYPES],
    url: '',
    secret: '',
    headers: [],
    smtpHost: '',
    smtpPort: '587',
    smtpSecure: false,
    smtpUser: '',
    smtpPassword: '',
    from: '',
    to: '',
  };
}

/** a stored channel, as the API shows it (secrets masked), in the form */
export function alertFormOf(channel: AlertChannel): AlertForm {
  const form = {
    ...blankAlertForm(channel.kind),
    name: channel.name,
    enabled: channel.enabled,
    events: [...channel.events],
  };
  switch (channel.kind) {
    case 'webhook':
      return {
        ...form,
        url: channel.url,
        secret: channel.secret ?? '',
        headers: Object.entries(channel.headers ?? {}).map(([key, value]) => ({
          key,
          value,
        })),
      };
    case 'slack':
      return { ...form, url: channel.url };
    case 'email':
      return {
        ...form,
        smtpHost: channel.smtp.host,
        smtpPort: String(channel.smtp.port),
        smtpSecure: channel.smtp.secure,
        smtpUser: channel.smtp.user ?? '',
        smtpPassword: channel.smtp.password ?? '',
        from: channel.from,
        to: channel.to.join(', '),
      };
  }
}

const recipients = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);

/** what the form would send. NOT validated: see {@link alertFormProblems} */
export function alertInputOf(form: AlertForm): unknown {
  const base = {
    kind: form.kind,
    name: form.name.trim(),
    enabled: form.enabled,
    events: form.events,
  };
  switch (form.kind) {
    case 'webhook': {
      const headers = Object.fromEntries(
        form.headers
          .filter((h) => h.key.trim())
          .map((h) => [h.key.trim(), h.value] as const),
      );
      return {
        ...base,
        url: form.url.trim(),
        ...(form.secret ? { secret: form.secret } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      };
    }
    case 'slack':
      return { ...base, url: form.url.trim() };
    case 'email':
      return {
        ...base,
        smtp: {
          host: form.smtpHost.trim(),
          port: form.smtpPort.trim(),
          secure: form.smtpSecure,
          ...(form.smtpUser.trim() ? { user: form.smtpUser.trim() } : {}),
          ...(form.smtpPassword ? { password: form.smtpPassword } : {}),
        },
        from: form.from.trim(),
        to: recipients(form.to),
      };
  }
}

export type AlertFormField =
  | 'name'
  | 'events'
  | 'url'
  | 'smtpHost'
  | 'smtpPort'
  | 'from'
  | 'to';

/**
 * the fields that are not right yet, by the schema the API itself applies — so
 * that Save is refused here, next to the field, and not by a 400 from the server.
 * a masked URL (the sentinel, on an edit) is a URL the server still has.
 */
export function alertFormProblems(
  form: AlertForm,
  opts: { editing: boolean },
): Set<AlertFormField> {
  const candidate = alertInputOf(form) as Record<string, unknown>;
  // on an edit the URL comes back masked, which is not a URL; the server puts the stored one back
  if (
    opts.editing &&
    typeof candidate.url === 'string' &&
    candidate.url.includes('•')
  ) {
    candidate.url = 'https://stored.invalid/';
  }
  const parsed = alertChannelInputSchema.safeParse(candidate);
  const problems = new Set<AlertFormField>();
  // …and on a NEW channel there is nothing stored for a mask to stand for
  if (
    !opts.editing &&
    typeof candidate.url === 'string' &&
    candidate.url.includes('•')
  )
    problems.add('url');
  if (parsed.success) return problems;
  for (const issue of parsed.error.issues) {
    const [head, second] = issue.path;
    if (head === 'smtp')
      problems.add(second === 'port' ? 'smtpPort' : 'smtpHost');
    else if (
      head === 'name' ||
      head === 'events' ||
      head === 'url' ||
      head === 'from' ||
      head === 'to'
    )
      problems.add(head);
  }
  return problems;
}

/** the validated input, or null while {@link alertFormProblems} has something to say */
export function validAlertInput(
  form: AlertForm,
  opts: { editing: boolean },
): AlertChannelInput | null {
  if (alertFormProblems(form, opts).size > 0) return null;
  // sent as the form has it (masked URL included): the server merges what it kept
  return alertInputOf(form) as AlertChannelInput;
}
