/**
 * isolateFailures: a failed batch is narrowed to the rows actually at fault,
 * healthy rows are delivered, and a destination that rejects everything is
 * recognised as systemic instead of being emptied into the dead-letter queue.
 */
import { describe, expect, it } from 'vitest';
import {
  isolateFailures,
  type IsolationAttempt,
  type IsolationOptions,
} from './isolate-failures';

const OPTS: IsolationOptions = {
  batchError: 'batch failed',
  maxAttempts: 128,
  maxPoisoned: 100,
  failuresBeforeSystemic: 14,
};

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/**
 * a destination that rejects any group containing a "bad" row, atomically —
 * exactly what a per-batch transaction does
 */
function destination(bad: ReadonlySet<number>) {
  const written: number[] = [];
  const calls: number[][] = [];
  const attempt = async (rows: number[]): Promise<IsolationAttempt> => {
    calls.push(rows);
    const culprit = rows.find((r) => bad.has(r));
    if (culprit !== undefined) {
      return {
        ok: false,
        error: `row ${culprit} rejected`,
        succeededTargets: [],
      };
    }
    written.push(...rows);
    return { ok: true, error: null, succeededTargets: [] };
  };
  return { attempt, written, calls };
}

describe('isolateFailures', () => {
  it('sets aside the one bad row and delivers every other row exactly once', async () => {
    const rows = range(1000);
    const dest = destination(new Set([617]));
    const res = await isolateFailures(rows, dest.attempt, OPTS);

    expect(res.systemic).toBe(false);
    expect(res.poisoned.map((p) => p.row)).toEqual([617]);
    expect(res.poisoned[0]!.error).toBe('row 617 rejected');
    // nothing dropped, nothing written twice
    expect([...dest.written].sort((a, b) => a - b)).toEqual(
      rows.filter((r) => r !== 617),
    );
    expect([...res.delivered].sort((a, b) => a - b)).toEqual(
      rows.filter((r) => r !== 617),
    );
  });

  it('costs about log2(n) attempts for a single bad row, not n', async () => {
    const dest = destination(new Set([3]));
    const res = await isolateFailures(range(100_000), dest.attempt, OPTS);
    expect(res.poisoned.map((p) => p.row)).toEqual([3]);
    // 17 levels; the known-bad shortcut saves the doomed half at each one
    expect(res.attempts).toBeLessThanOrEqual(36);
  });

  it('finds several bad rows wherever they sit, including the edges', async () => {
    const bad = new Set([0, 499, 500, 999]);
    const rows = range(1000);
    const dest = destination(bad);
    const res = await isolateFailures(rows, dest.attempt, OPTS);

    expect(res.systemic).toBe(false);
    expect(res.poisoned.map((p) => p.row).sort((a, b) => a - b)).toEqual([
      0, 499, 500, 999,
    ]);
    expect([...dest.written].sort((a, b) => a - b)).toEqual(
      rows.filter((r) => !bad.has(r)),
    );
  });

  it('never sets a row aside without it failing on its own', async () => {
    const dest = destination(new Set([1]));
    await isolateFailures(range(2), dest.attempt, OPTS);
    // row 0 succeeds alone, which proves row 1 is at fault — but row 1 is still
    // attempted by itself before being dead-lettered
    expect(dest.calls).toContainEqual([1]);
  });

  it('recovers when the batch failure was transient', async () => {
    // the full batch failed, but nothing is actually wrong with any row
    const dest = destination(new Set());
    const rows = range(64);
    const res = await isolateFailures(rows, dest.attempt, OPTS);
    expect(res.systemic).toBe(false);
    expect(res.poisoned).toEqual([]);
    expect([...dest.written].sort((a, b) => a - b)).toEqual(rows);
  });

  it('treats a destination that rejects everything as systemic', async () => {
    const rows = range(10_000);
    const attempt = async (): Promise<IsolationAttempt> => ({
      ok: false,
      error: 'connection refused',
      succeededTargets: [],
    });
    const res = await isolateFailures(rows, attempt, OPTS);

    expect(res.systemic).toBe(true);
    expect(res.reason).toContain('connection refused');
    expect(res.delivered).toEqual([]);
    // gives up early instead of trying all ten thousand rows one by one
    expect(res.attempts).toBe(OPTS.failuresBeforeSystemic);
  });

  it('gives up when too many rows in one batch are bad', async () => {
    const rows = range(400);
    // the right half is clean (so this is not "everything fails"), but every
    // other row of the left half is bad: a destination problem, not a poison row
    const bad = new Set(rows.filter((r) => r < 200 && r % 2 === 1));
    const dest = destination(bad);
    const res = await isolateFailures(rows, dest.attempt, {
      ...OPTS,
      maxPoisoned: 5,
      maxAttempts: 10_000,
    });
    expect(res.systemic).toBe(true);
    expect(res.reason).toContain('more than 5 rows');
  });

  it('gives up when the attempt budget runs out', async () => {
    const rows = range(4096);
    // clean right half, so only the budget can end this search
    const bad = new Set(rows.filter((r) => r < 2048 && r % 64 === 0));
    const dest = destination(bad);
    const res = await isolateFailures(rows, dest.attempt, {
      ...OPTS,
      maxAttempts: 20,
    });
    expect(res.systemic).toBe(true);
    expect(res.reason).toContain('gave up');
    expect(res.attempts).toBe(20);
  });

  it('a small batch that fails outright is reported row by row, not as systemic', async () => {
    // below the systemic threshold there is no way to tell two bad rows from a
    // dead destination; the caller's consecutive-failure guard covers that
    const attempt = async (): Promise<IsolationAttempt> => ({
      ok: false,
      error: 'violates check constraint',
      succeededTargets: [],
    });
    const res = await isolateFailures([1, 2], attempt, OPTS);
    expect(res.systemic).toBe(false);
    expect(res.poisoned.map((p) => p.row)).toEqual([1, 2]);
    expect(res.delivered).toEqual([]);
  });

  it('a single-row batch is its own failure and costs no extra attempts', async () => {
    let called = 0;
    const attempt = async (): Promise<IsolationAttempt> => {
      called++;
      return { ok: true, error: null, succeededTargets: [] };
    };
    const res = await isolateFailures([42], attempt, {
      ...OPTS,
      alreadySucceeded: ['t1'],
    });
    expect(called).toBe(0);
    expect(res.poisoned).toEqual([
      { row: 42, error: 'batch failed', succeededTargets: ['t1'] },
    ]);
  });

  it('handles an empty batch', async () => {
    const res = await isolateFailures([], destination(new Set()).attempt, OPTS);
    expect(res).toMatchObject({
      delivered: [],
      poisoned: [],
      systemic: false,
      attempts: 0,
    });
  });

  describe('fan-out', () => {
    it('never rewrites a target the full batch already committed to', async () => {
      const seenSkips: string[][] = [];
      const attempt = async (
        rows: number[],
        skip: ReadonlySet<string>,
      ): Promise<IsolationAttempt> => {
        seenSkips.push([...skip]);
        return rows.includes(5)
          ? { ok: false, error: 'rejected by B', succeededTargets: [] }
          : { ok: true, error: null, succeededTargets: [] };
      };
      const res = await isolateFailures(range(8), attempt, {
        ...OPTS,
        alreadySucceeded: ['A'],
      });
      expect(seenSkips.every((s) => s.includes('A'))).toBe(true);
      expect(res.poisoned).toEqual([
        { row: 5, error: 'rejected by B', succeededTargets: ['A'] },
      ]);
    });

    it('carries a target that committed part-way down into the rows below it', async () => {
      // two failing targets: C takes any group, B rejects rows 0 and 2. once C
      // has committed a group, its sub-groups must skip C (insert mode would
      // otherwise duplicate those rows in C)
      const skipsByRows = new Map<string, string[]>();
      const attempt = async (
        rows: number[],
        skip: ReadonlySet<string>,
      ): Promise<IsolationAttempt> => {
        skipsByRows.set(rows.join(','), [...skip]);
        return rows.includes(0) || rows.includes(2)
          ? { ok: false, error: 'rejected by B', succeededTargets: ['C'] }
          : { ok: true, error: null, succeededTargets: [] };
      };
      const res = await isolateFailures(range(4), attempt, OPTS);

      expect(skipsByRows.get('0,1')).toEqual([]); // first time C sees these rows
      expect(skipsByRows.get('0')).toEqual(['C']); // C already holds row 0
      expect(skipsByRows.get('2,3')).toEqual([]);
      expect(skipsByRows.get('2')).toEqual(['C']);
      expect(res.poisoned.map((p) => p.row)).toEqual([0, 2]);
      expect(res.poisoned.every((p) => p.succeededTargets.includes('C'))).toBe(
        true,
      );
      expect([...res.delivered].sort()).toEqual([1, 3]);
    });
  });
});
