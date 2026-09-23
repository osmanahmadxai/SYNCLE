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
    /**
     * keys remembered at most. part of every key is chosen by whoever is
     * knocking (a user name, an address they claim to come from), and an entry
     * was never forgotten until that key succeeded — so a stream of made-up
     * names was a slow, unbounded leak
     */
    private readonly maxKeys = 10_000,
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
    // re-inserted so that iteration order is "least recently failed first"
    this.entries.delete(key);
    this.entries.set(key, e);
    if (this.entries.size > this.maxKeys) this.forget(now);
  }

  /** make room: whatever is not locked right now goes first, then the oldest */
  private forget(now: number): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxKeys) return;
      if (entry.lockedUntil <= now) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxKeys) return;
      this.entries.delete(key);
    }
  }

  /** how many keys are being remembered (for tests and diagnostics) */
  get size(): number {
    return this.entries.size;
  }

  /** a successful attempt clears the slate for the key */
  succeed(key: string): void {
    this.entries.delete(key);
  }
}
