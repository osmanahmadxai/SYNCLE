/**
 * tiny in-memory attempt limiter for the auth endpoints. sliding lockout:
 * after `maxFailures` consecutive failures for a key, further attempts are
 * rejected for a cooldown that doubles with each subsequent failure (capped).
 * success clears the key. single-process by design — the API runs as one
 * process, and durable rate limiting would be overkill for a single-operator
 * tool; the point is making online guessing impractical, not accounting.
 */
export class AttemptLimiter {
  private readonly entries = new Map<
    string,
    { failures: number; lockedUntil: number }
  >();

  constructor(
    private readonly maxFailures = 5,
    private readonly baseLockMs = 30_000,
    private readonly maxLockMs = 15 * 60_000,
  ) {}

  /** ms until the key may try again; 0 when it is free to proceed */
  retryAfterMs(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    return e.lockedUntil > now ? e.lockedUntil - now : 0;
  }

  /** record a failed attempt; starts/extends the lockout past the threshold */
  fail(key: string, now = Date.now()): void {
    const e = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 };
    e.failures += 1;
    if (e.failures >= this.maxFailures) {
      const over = e.failures - this.maxFailures;
      const lock = Math.min(this.baseLockMs * 2 ** over, this.maxLockMs);
      e.lockedUntil = now + lock;
    }
    this.entries.set(key, e);
  }

  /** a successful attempt clears the slate for the key */
  succeed(key: string): void {
    this.entries.delete(key);
  }
}
