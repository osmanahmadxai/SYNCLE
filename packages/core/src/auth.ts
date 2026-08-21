/**
 * authentication + app-settings contracts, shared by the API and the web app.
 * this is a single-operator ("admin") auth model: one account, created on first
 * run, protecting every endpoint. no driver imports, so it stays browser-safe.
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

export type SetupDTO = z.infer<typeof setupSchema>;
export type LoginDTO = z.infer<typeof loginSchema>;
export type ChangePasswordDTO = z.infer<typeof changePasswordSchema>;

/** the signed-in user as returned to the client (never includes secrets) */
export interface AuthUser {
  id: string;
  username: string;
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
    defaultPollIntervalMs: z.coerce.number().int().min(1000).max(3_600_000).optional(),
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
}
