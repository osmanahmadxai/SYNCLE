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
