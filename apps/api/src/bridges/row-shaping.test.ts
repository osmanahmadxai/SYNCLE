import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UNCHANGED } from '@syncle/core';
import { failedBeforeSending } from './bridge-sink.service';
import { shapeRows } from './row-shaping';
import type { ResolvedBridge } from './bridges.types';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ctx = { table: 'users', now: '2026-09-17T10:00:00.000Z' };

/** only `transform.columns` is read */
const bridge = (columns: unknown[] | undefined): ResolvedBridge =>
  ({
    transform: { template: '{{$row}}', columns },
  }) as unknown as ResolvedBridge;

describe('shapeRows', () => {
  it('hands the very same rows back when the bridge has no steps', () => {
    const rows = [{ id: 1 }];
    expect(shapeRows(bridge(undefined), rows, ctx).rows).toBe(rows);
    expect(shapeRows(bridge([]), rows, ctx).rows).toBe(rows);
  });

  it('hashes with a real SHA-256, salted, and does not touch the rows it was given', () => {
    const rows = [{ id: 1, email: 'ada@example.com' }];
    const out = shapeRows(
      bridge([
        {
          kind: 'mask',
          column: 'email',
          mode: 'hash',
          salt: 'pepper',
          keepStart: 0,
          keepEnd: 4,
          fill: '*',
        },
      ]),
      rows,
      ctx,
    );
    expect(out.rows).toEqual([{ id: 1, email: sha('pepperada@example.com') }]);
    expect(rows[0]!.email).toBe('ada@example.com');
  });

  it('a delete masks the key it arrives with, and computes nothing for a row that is going away', () => {
    const steps = [
      {
        kind: 'mask',
        column: 'email',
        mode: 'hash',
        keepStart: 0,
        keepEnd: 4,
        fill: '*',
      },
      { kind: 'set', column: 'label', template: 'user {{email}}' },
      { kind: 'default', column: 'tier', value: 'free' },
    ];
    const deleted = shapeRows(bridge(steps), [{ email: 'ada@example.com' }], {
      ...ctx,
      op: 'delete',
    });
    expect(deleted.rows).toEqual([{ email: sha('ada@example.com') }]);
    const inserted = shapeRows(bridge(steps), [{ email: 'ada@example.com' }], {
      ...ctx,
      op: 'insert',
    });
    expect(inserted.rows[0]).toEqual({
      email: sha('ada@example.com'),
      label: `user ${sha('ada@example.com')}`,
      tier: 'free',
    });
  });

  it('a truncate has no rows to speak of, and is left alone', () => {
    const rows = [{}];
    expect(
      shapeRows(
        bridge([{ kind: 'default', column: 'tier', value: 'free' }]),
        rows,
        { ...ctx, op: 'truncate' },
      ).rows,
    ).toBe(rows);
  });

  it('says a problem once, however many rows have it', () => {
    const steps = [
      { kind: 'cast', column: 'n', to: 'number', onError: 'fail' },
      { kind: 'cast', column: 'm', to: 'number', onError: 'null' },
    ];
    const out = shapeRows(
      bridge(steps),
      [
        { n: 'x', m: 'y' },
        { n: 'x', m: 'y' },
        { n: '3', m: '4' },
      ],
      ctx,
    );
    expect(out.errors).toEqual(['cast n: "x" is not a number']);
    expect(out.warnings).toEqual([
      'cast m: "y" is not a number; written as NULL',
    ]);
    expect(out.rows[2]).toEqual({ n: 3, m: 4 });
  });

  it('leaves a column the source did not resend as the marker it is', () => {
    const out = shapeRows(
      bridge([
        {
          kind: 'mask',
          column: 'body',
          mode: 'hash',
          keepStart: 0,
          keepEnd: 4,
          fill: '*',
        },
      ]),
      [{ id: 1, body: UNCHANGED }],
      ctx,
    );
    expect(out.rows[0]!.body).toBe(UNCHANGED);
  });
});

describe('failedBeforeSending', () => {
  it('is a failed delivery that was never attempted, and says how to get past it', () => {
    const outcome = failedBeforeSending(
      ['cast n: "x" is not a number'],
      'update',
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      attempts: 0,
      httpStatus: null,
      requestBody: null,
      op: 'update',
    });
    expect(outcome.error).toBe(
      'Column transform failed — cast n: "x" is not a number. Fix the source value, or set the cast\'s "on error" to null or keep.',
    );
  });

  it('shows five problems and counts the rest', () => {
    const errors = Array.from(
      { length: 8 },
      (_, i) => `cast c${i}: "x" is not a number`,
    );
    const { error } = failedBeforeSending(errors);
    expect(error).toContain('cast c4');
    expect(error).not.toContain('cast c5');
    expect(error).toContain('; and 3 more');
  });
});
