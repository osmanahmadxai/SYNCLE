import { describe, expect, it } from 'vitest';
import { AttemptLimiter } from './attempt-limiter';

describe('AttemptLimiter', () => {
  it('locks after the failure threshold and backs off exponentially', () => {
    const l = new AttemptLimiter(3, 1000, 8000);
    const t0 = 1_000_000;
    expect(l.retryAfterMs('k', t0)).toBe(0);
    l.fail('k', t0);
    l.fail('k', t0);
    expect(l.retryAfterMs('k', t0)).toBe(0); // below threshold
    l.fail('k', t0);
    expect(l.retryAfterMs('k', t0)).toBe(1000); // 3rd failure locks
    l.fail('k', t0);
    expect(l.retryAfterMs('k', t0)).toBe(2000); // doubles
    l.fail('k', t0);
    l.fail('k', t0);
    l.fail('k', t0);
    expect(l.retryAfterMs('k', t0)).toBe(8000); // capped
  });

  it('unlocks when the cooldown elapses and clears on success', () => {
    const l = new AttemptLimiter(1, 1000, 8000);
    const t0 = 5_000;
    l.fail('k', t0);
    expect(l.retryAfterMs('k', t0 + 999)).toBe(1);
    expect(l.retryAfterMs('k', t0 + 1000)).toBe(0);
    l.succeed('k');
    l.fail('other', t0);
    expect(l.retryAfterMs('k', t0)).toBe(0); // keys are independent
  });
});

describe('memory', () => {
  it('does not grow without bound on made-up keys', () => {
    // part of every key is chosen by whoever is knocking. an entry used to live
    // until that key SUCCEEDED, which a made-up user name never does
    const limiter = new AttemptLimiter(5, 30_000, 900_000, 100);
    for (let i = 0; i < 5_000; i++)
      limiter.fail(`203.0.113.7:user-${i}`, 1_000 + i);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it('forgets the harmless before the locked: making room must not unlock anyone', () => {
    const limiter = new AttemptLimiter(3, 60_000, 900_000, 50);
    for (let i = 0; i < 3; i++) limiter.fail('the-guesser', 1_000);
    expect(limiter.retryAfterMs('the-guesser', 1_001)).toBeGreaterThan(0);
    for (let i = 0; i < 500; i++) limiter.fail(`noise-${i}`, 2_000);
    expect(limiter.size).toBeLessThanOrEqual(50);
    expect(limiter.retryAfterMs('the-guesser', 2_001)).toBeGreaterThan(0);
  });
});
