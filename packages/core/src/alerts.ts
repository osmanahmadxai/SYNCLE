/**
 * Alerts: telling someone when a bridge needs them.
 *
 * A bridge that stops at 3 a.m. used to say so in exactly one place — its own
 * page, to whoever happened to open it. An alert channel is somewhere to say it
 * out loud: a webhook, a Slack channel, an e-mail address.
 */
import { z } from 'zod';

/**
 * what can be alerted on. deliberately few, and each one is a moment at which
 * a person has something to do:
 *
 *   bridge.failed         a bridge or a replay stopped because of a failure
 *   bridge.position_lost  a live bridge lost its place in the source's change
 *                         log: it cannot resume without accepting a gap
 *   bridge.dead_letters   rows were set aside in a bridge's dead-letter queue
 *   source.hold           a bridge is making its SOURCE keep change log (a
 *                         PostgreSQL slot pinning WAL) beyond the warning level
 */
export const alertEventTypeSchema = z.enum([
  'bridge.failed',
  'bridge.position_lost',
  'bridge.dead_letters',
  'source.hold',
]);
export type AlertEventType = z.infer<typeof alertEventTypeSchema>;
export const ALERT_EVENT_TYPES = alertEventTypeSchema.options;

/** one thing that happened, as every channel is told it */
export interface AlertEvent {
  type: AlertEventType | 'test';
  /** 'warning' can wait for the morning; 'critical' cannot */
  severity: 'warning' | 'critical';
  /** one line: what happened, to what */
  title: string;
  /** the explanation, as the bridge's own page gives it */
  message: string;
  bridgeId?: string;
  bridgeName?: string;
  jobId?: string;
  /** ISO timestamp */
  at: string;
  /** how many more of the same were NOT sent since the last one (see throttling) */
  suppressed?: number;
}

const name = z.string().trim().min(1).max(120);
const events = z
  .array(alertEventTypeSchema)
  .min(1)
  .max(ALERT_EVENT_TYPES.length);
const httpUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');
const email = z.string().trim().email().max(320);

export const alertChannelInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('webhook'),
    name,
    enabled: z.boolean().default(true),
    events,
    /** receives a POST with the {@link AlertEvent} as JSON */
    url: httpUrl,
    /** extra request headers (an API key the receiver wants, say) */
    headers: z.record(z.string().max(200), z.string().max(2000)).optional(),
    /**
     * when set, every request carries `X-Syncle-Signature: sha256=<hex>` — the
     * HMAC of the exact body bytes under this secret — so the receiver can tell
     * a real alert from anyone who found the URL
     */
    secret: z.string().max(500).optional(),
  }),
  z.object({
    kind: z.literal('slack'),
    name,
    enabled: z.boolean().default(true),
    events,
    /** a Slack "incoming webhook" URL (it IS the credential) */
    url: httpUrl,
  }),
  z.object({
    kind: z.literal('email'),
    name,
    enabled: z.boolean().default(true),
    events,
    smtp: z.object({
      host: z.string().trim().min(1).max(255),
      port: z.coerce.number().int().min(1).max(65535).default(587),
      /** true = TLS from the first byte (port 465); false = STARTTLS when offered */
      secure: z.boolean().default(false),
      user: z.string().max(320).optional(),
      password: z.string().max(1000).optional(),
    }),
    from: email,
    to: z.array(email).min(1).max(20),
  }),
]);
export type AlertChannelInput = z.infer<typeof alertChannelInputSchema>;
export type AlertChannelKind = AlertChannelInput['kind'];

/** what a secret reads as once stored: present, never shown */
export const ALERT_SECRET_SENTINEL = '••••••••';

/**
 * a channel as the API returns it. secrets (a webhook's signing secret and
 * header values, a Slack URL's token part, an SMTP password) come back as
 * {@link ALERT_SECRET_SENTINEL}; sending the sentinel back on an update keeps
 * what is stored.
 */
export type AlertChannel = AlertChannelInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** the outcome of the last thing sent, or null when nothing has been */
  lastStatus: 'ok' | 'failed' | null;
  lastError: string | null;
  lastSentAt: string | null;
};

export interface AlertTestResult {
  ok: boolean;
  /** the receiver's answer, or why it could not be reached */
  detail: string;
}
