/**
 * authentication + app-settings contracts, shared by the API and the web app.
 * one account is made at first run (an admin); it can make more, each with a
 * role. every endpoint is behind them. no driver imports, so it stays browser-safe.
 */
import { z } from 'zod';

/** username: a simple handle, not an email; kept forgiving but bounded */
const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(60, 'Username is too long');

/** password policy — long enough to matter, capped so a huge body can't DoS scrypt */
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200, 'Password is too long');

export const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  /** one-time token printed to the server console on first boot (TOFU guard) */
  setupToken: z.string().min(1, 'Setup token is required').max(64),
});

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required').max(60),
  password: z.string().min(1, 'Password is required').max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(200),
  newPassword: passwordSchema,
});

/**
 * a password reset for an operator who cannot sign in. there is no e-mail to
 * send a link to: the proof of being the operator is the same as at first run —
 * being able to read the server's console (or its data directory), where the
 * code is put when it is asked for
 */
export const passwordResetSchema = z.object({
  resetCode: z.string().trim().min(1, 'Reset code is required').max(64),
  newPassword: passwordSchema,
});

/**
 * whose password: with more than one account the code has to be for somebody.
 * left out, it is the first admin's — what a `syncle reset-password` with no
 * name, and every installation from before there were roles, expects
 */
export const passwordResetRequestSchema = z.object({
  username: z.string().trim().max(60).optional(),
});

export type SetupDTO = z.infer<typeof setupSchema>;
export type PasswordResetDTO = z.infer<typeof passwordResetSchema>;
export type PasswordResetRequestDTO = z.infer<
  typeof passwordResetRequestSchema
>;
export type LoginDTO = z.infer<typeof loginSchema>;
export type ChangePasswordDTO = z.infer<typeof changePasswordSchema>;

/* ----- accounts and roles ----- */

/**
 * what an account may do, when signed in:
 *
 *   admin     everything — including the accounts, the API keys, the settings,
 *             the alert channels, the workspaces, the master key, the audit log
 *   operator  the work: connections, bridges, runs, the data browser. not the
 *             things above
 *   viewer    may look: every GET. nothing that changes anything (except their
 *             own password)
 *
 * (an API key is not an account: it has a scope, see below)
 */
export const userRoleSchema = z.enum(['admin', 'operator', 'viewer']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const userInputSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: userRoleSchema.default('operator'),
});
export type UserInputDTO = z.infer<typeof userInputSchema>;

/** what an admin may change about an account. nothing given = nothing to do */
export const userUpdateSchema = z
  .object({
    role: userRoleSchema.optional(),
    /** a new password set by an admin: every session of the account ends */
    newPassword: passwordSchema.optional(),
    /** a disabled account cannot sign in, and its sessions are over; it keeps its name and its history */
    disabled: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.newPassword !== undefined ||
      v.disabled !== undefined,
    'Nothing to change: give a role, a new password, or whether the account is disabled.',
  );
export type UserUpdateDTO = z.infer<typeof userUpdateSchema>;

/** an account as it is listed to an admin */
export interface UserInfo {
  id: string;
  username: string;
  role: UserRole;
  disabledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** the signed-in user as returned to the client (never includes secrets) */
export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

/**
 * unauthenticated status probe the web app calls on load to decide which screen
 * to show: the first-run setup, the login form, or the app itself.
 */
export interface AuthStatus {
  /** no account exists yet — show the create-admin screen */
  needsSetup: boolean;
  /** the current request carries a valid session */
  authenticated: boolean;
  /** present only when authenticated */
  user: AuthUser | null;
}

/* ----- application settings (global, single-operator) ----- */

/**
 * server-side tunables editable from the Settings screen. every field is
 * optional on input (partial updates), and the server fills unset values with
 * its env/built-in defaults when reading.
 */
export const appSettingsSchema = z.preprocess(
  (val) => {
    // legacy key (transition): settings persisted before the bridges/jobs
    // rename stored this field as `hookConcurrency` — keep honoring it
    if (
      val &&
      typeof val === 'object' &&
      'hookConcurrency' in (val as Record<string, unknown>) &&
      !('jobConcurrency' in (val as Record<string, unknown>))
    ) {
      const { hookConcurrency, ...rest } = val as Record<string, unknown>;
      return { ...rest, jobConcurrency: hookConcurrency };
    }
    return val;
  },
  z.object({
    /** default poll cadence a new polling bridge is seeded with (ms) */
    defaultPollIntervalMs: z.coerce
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .optional(),
    /** default rows fetched per poll for a new polling bridge */
    defaultMaxPerPoll: z.coerce.number().int().min(1).max(5000).optional(),
    /** operations a new CDC bridge captures by default */
    defaultCdcOperations: z
      .array(z.enum(['insert', 'update', 'delete']))
      .min(1)
      .optional(),
    /** hard cap on rows returned by a single ad-hoc query */
    maxQueryRows: z.coerce.number().int().min(1).max(1_000_000).optional(),
    /** idle ms before a pooled database connection is closed */
    poolIdleMs: z.coerce.number().int().min(10_000).max(86_400_000).optional(),
    /** how many replay jobs may execute concurrently (applies on next boot) */
    jobConcurrency: z.coerce.number().int().min(1).max(100).optional(),
    /** minutes of inactivity before a login session expires */
    sessionTtlMinutes: z.coerce.number().int().min(15).max(43_200).optional(),
    /**
     * days a delivery's details (payload, response, timing) are kept. the job's
     * delivered / failed / skipped counters are not affected. 0 = keep for ever
     */
    deliveryRetentionDays: z.coerce.number().int().min(0).max(3650).optional(),
    /**
     * how many deliveries a LIVE (watch / CDC) job keeps, however recent — it
     * never finishes, so age alone does not bound it. 0 = no limit
     */
    deliveryMaxPerJob: z.coerce
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .optional(),
    /** days the audit log is kept. 0 = for ever */
    auditRetentionDays: z.coerce.number().int().min(0).max(3650).optional(),
  }),
);

export type AppSettingsDTO = z.infer<typeof appSettingsSchema>;

/** the fully-resolved settings (defaults merged with overrides) the API returns */
export interface AppSettings {
  defaultPollIntervalMs: number;
  defaultMaxPerPoll: number;
  defaultCdcOperations: ('insert' | 'update' | 'delete')[];
  maxQueryRows: number;
  poolIdleMs: number;
  jobConcurrency: number;
  sessionTtlMinutes: number;
  deliveryRetentionDays: number;
  deliveryMaxPerJob: number;
  auditRetentionDays: number;
}

/* -------------------------------------------------------------------------- */
/* API keys                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `read`  may look: every GET. nothing else — not even a POST that only reads,
 *         so that what a read key can do is answerable by looking at the verb
 * `full`  may do what the operator can, EXCEPT what concerns credentials: it
 *         cannot create or revoke keys, change the password, or end sessions
 */
export const apiKeyScopeSchema = z.enum(['read', 'full']);
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

export const apiKeyInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name the key after what will use it')
    .max(120),
  scope: apiKeyScopeSchema.default('read'),
  /** days until it stops working; omitted = it does not expire */
  expiresInDays: z.coerce.number().int().min(1).max(3650).optional(),
});
export type ApiKeyInputDTO = z.infer<typeof apiKeyInputSchema>;

/** a key as it is listed: never the key itself */
export interface ApiKeyInfo {
  id: string;
  name: string;
  /** how the key starts (`syn_a1b2c3d4…`), to tell it from the others */
  prefix: string;
  scope: ApiKeyScope;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** the answer to creating a key: the only time the key itself is ever sent */
export interface ApiKeyCreated extends ApiKeyInfo {
  key: string;
}

/* -------------------------------------------------------------------------- */
/* the audit log: who did what                                                */
/* -------------------------------------------------------------------------- */

/**
 * what is recorded. every change made through the API (by an account or an API
 * key), and every sign-in — succeeded or not. reads are not: they are the
 * ordinary use of the app, and would drown the rest.
 */
export const AUDIT_ACTIONS = [
  'auth.setup',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_changed',
  'auth.reset_requested',
  'auth.password_reset',
  'user.create',
  'user.update',
  'user.delete',
  'user.sessions_ended',
  'api_key.create',
  'api_key.revoke',
  'settings.update',
  'encryption.rotate',
  'workspace.create',
  'workspace.update',
  'workspace.delete',
  'connection.create',
  'connection.update',
  'connection.delete',
  'connection.query',
  'connection.rows_insert',
  'connection.rows_update',
  'connection.rows_delete',
  'connection.ddl',
  'connection.restore',
  'bridge.create',
  'bridge.update',
  'bridge.delete',
  'bridge.import',
  'bridge.bulk_create',
  'bridge.clone',
  'bridge.run',
  'bridge.cancel',
  'bridge.retry',
  'bridge.skip',
  'bridge.start',
  'bridge.stop',
  'bridge.dead_letters_retry',
  'bridge.dead_letters_discard',
  'bridge.verify',
  'bridge.verify_cancel',
  'bridge.schema_accepted',
  'bridge.slot_surrendered',
  'bridge.cleanups_retry',
  'bridge.cleanup_dismissed',
  'retention.run',
  'alert_channel.create',
  'alert_channel.update',
  'alert_channel.delete',
  'alert_channel.test',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditActor {
  type: 'user' | 'apiKey' | 'system';
  /** absent for the system, and for a sign-in that named nobody who exists */
  id: string | null;
  /** the name at the time: an entry outlives the account or key that made it */
  name: string;
}

export interface AuditTarget {
  type: string;
  id: string | null;
  name: string | null;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: AuditActor;
  action: AuditAction | string;
  target: AuditTarget | null;
  /** what changed, in short. never a secret */
  details: Record<string, unknown> | null;
  ip: string | null;
}

/** newest first, a page at a time: `before` is the `next` of the page before */
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(80).optional(),
  action: z.string().trim().max(60).optional(),
  /** an actor's name, as it was recorded */
  actor: z.string().trim().max(120).optional(),
  targetId: z.string().trim().max(200).optional(),
  targetType: z.string().trim().max(40).optional(),
});
export type AuditQueryDTO = z.infer<typeof auditQuerySchema>;

export interface AuditPage {
  entries: AuditEntry[];
  /** pass as `before` for the page after this one; null = this was the last */
  next: string | null;
}
