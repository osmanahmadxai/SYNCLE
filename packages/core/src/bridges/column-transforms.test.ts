import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyColumnTransforms,
  canBecomeNull,
  columnTransformSchema,
  copiedColumn,
  columnsAdded,
  columnsRead,
  transformedType,
  type ColumnTransform,
} from './column-transforms';

const ctx = {
  table: 'users',
  now: '2026-09-17T10:00:00.000Z',
  hash: (s: string) => createHash('sha256').update(s).digest('hex'),
};
const parse = (t: unknown): ColumnTransform => columnTransformSchema.parse(t);
const run = (row: Record<string, unknown>, ...transforms: unknown[]) =>
  applyColumnTransforms(row, transforms.map(parse), ctx);

describe('mask', () => {
  it('redact hides the value AND its length', () => {
    const short = run(
      { pin: '1' },
      { kind: 'mask', column: 'pin', mode: 'redact' },
    ).row.pin;
    const long = run(
      { pin: 'a very long secret indeed' },
      { kind: 'mask', column: 'pin', mode: 'redact' },
    ).row.pin;
    expect(short).toBe('********');
    expect(long).toBe(short);
  });

  it('partial keeps the ends — the last four by default — and the length', () => {
    expect(
      run(
        { card: '4111111111111111' },
        { kind: 'mask', column: 'card', mode: 'partial' },
      ).row.card,
    ).toBe('************1111');
    expect(
      run(
        { email: 'ada@example.com' },
        {
          kind: 'mask',
          column: 'email',
          mode: 'partial',
          keepStart: 1,
          keepEnd: 4,
        },
      ).row.email,
    ).toBe('a**********.com');
  });

  it('partial gives nothing away of a value too short to keep part of', () => {
    expect(
      run({ pin: '1234' }, { kind: 'mask', column: 'pin', mode: 'partial' }).row
        .pin,
    ).toBe('****');
    expect(
      run(
        { pin: '12' },
        {
          kind: 'mask',
          column: 'pin',
          mode: 'partial',
          keepStart: 2,
          keepEnd: 2,
        },
      ).row.pin,
    ).toBe('**');
  });

  it('partial counts characters, not UTF-16 halves', () => {
    expect(
      run(
        { name: '😀😀😀😀😀😀' },
        { kind: 'mask', column: 'name', mode: 'partial', keepEnd: 2 },
      ).row.name,
    ).toBe('****😀😀');
  });

  it('hash is stable, so a hashed key still joins and deduplicates', () => {
    const a = run(
      { email: 'ada@example.com' },
      { kind: 'mask', column: 'email', mode: 'hash' },
    ).row.email;
    const b = run(
      { email: 'ada@example.com' },
      { kind: 'mask', column: 'email', mode: 'hash' },
    ).row.email;
    expect(a).toBe(b);
    expect(a).toBe(ctx.hash('ada@example.com'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a salt changes the hash: a table of common values cannot be looked up', () => {
    const plain = run({ v: 'yes' }, { kind: 'mask', column: 'v', mode: 'hash' })
      .row.v;
    const salted = run(
      { v: 'yes' },
      { kind: 'mask', column: 'v', mode: 'hash', salt: 'pepper' },
    ).row.v;
    expect(salted).not.toBe(plain);
  });

  it('null drops the value and keeps the column; a NULL stays NULL under every mode', () => {
    expect(
      run({ ssn: '123' }, { kind: 'mask', column: 'ssn', mode: 'null' }).row,
    ).toEqual({ ssn: null });
    for (const mode of ['redact', 'partial', 'hash', 'null']) {
      expect(
        run({ v: null }, { kind: 'mask', column: 'v', mode }).row.v,
      ).toBeNull();
    }
  });

  it('masks numbers and objects too, by their text', () => {
    expect(
      run({ n: 1234567890 }, { kind: 'mask', column: 'n', mode: 'partial' }).row
        .n,
    ).toBe('******7890');
    expect(
      run({ doc: { a: 1 } }, { kind: 'mask', column: 'doc', mode: 'redact' })
        .row.doc,
    ).toBe('********');
  });
});

describe('cast', () => {
  it('turns text into numbers, integers, booleans, dates and JSON', () => {
    const { row, warnings } = run(
      {
        a: ' 12.75 ',
        b: '12.75',
        c: 'Yes',
        d: '2026-01-02T03:04:05Z',
        e: '{"x":[1]}',
        f: 42,
      },
      { kind: 'cast', column: 'a', to: 'number' },
      { kind: 'cast', column: 'b', to: 'integer' },
      { kind: 'cast', column: 'c', to: 'boolean' },
      { kind: 'cast', column: 'd', to: 'date' },
      { kind: 'cast', column: 'e', to: 'json' },
      { kind: 'cast', column: 'f', to: 'string' },
    );
    expect(row).toEqual({
      a: 12.75,
      b: 12,
      c: true,
      d: '2026-01-02T03:04:05.000Z',
      e: { x: [1] },
      f: '42',
    });
    expect(warnings).toEqual([]);
  });

  it('reads epoch seconds and milliseconds as dates', () => {
    expect(
      run({ t: 1767323045 }, { kind: 'cast', column: 't', to: 'date' }).row.t,
    ).toBe('2026-01-02T03:04:05.000Z');
    expect(
      run({ t: 1767323045000 }, { kind: 'cast', column: 't', to: 'date' }).row
        .t,
    ).toBe('2026-01-02T03:04:05.000Z');
  });

  it('a value that cannot be cast FAILS by default, naming the column and the value', () => {
    const { row, errors, warnings } = run(
      { amount: 'n/a', ok: 'maybe', at: 'not a date', doc: '{broken' },
      { kind: 'cast', column: 'amount', to: 'number' },
      { kind: 'cast', column: 'ok', to: 'boolean' },
      { kind: 'cast', column: 'at', to: 'date' },
      { kind: 'cast', column: 'doc', to: 'json' },
    );
    expect(errors).toHaveLength(4);
    expect(errors[0]).toBe('cast amount: "n/a" is not a number');
    expect(warnings).toEqual([]);
    // the row itself is untouched: what happens to it is the caller's decision
    expect(row).toEqual({
      amount: 'n/a',
      ok: 'maybe',
      at: 'not a date',
      doc: '{broken',
    });
  });

  it('…or becomes NULL, or is kept, when that is what was chosen — and says which', () => {
    const asNull = run(
      { amount: 'n/a' },
      { kind: 'cast', column: 'amount', to: 'number', onError: 'null' },
    );
    expect(asNull.row.amount).toBeNull();
    expect(asNull.errors).toEqual([]);
    expect(asNull.warnings).toEqual([
      'cast amount: "n/a" is not a number; written as NULL',
    ]);

    const kept = run(
      { amount: 'n/a' },
      { kind: 'cast', column: 'amount', to: 'number', onError: 'keep' },
    );
    expect(kept.row.amount).toBe('n/a');
    expect(kept.errors).toEqual([]);
    expect(kept.warnings).toEqual([
      'cast amount: "n/a" is not a number; left as it was',
    ]);
  });

  it('an empty string is not zero', () => {
    const { row, errors } = run(
      { n: '' },
      { kind: 'cast', column: 'n', to: 'number' },
    );
    expect(row.n).toBe('');
    expect(errors).toHaveLength(1);
  });

  it('NULL stays NULL, and a bigint stays exact', () => {
    expect(
      run({ n: null }, { kind: 'cast', column: 'n', to: 'integer' }).row.n,
    ).toBeNull();
    expect(
      run(
        { n: 9007199254740993n },
        { kind: 'cast', column: 'n', to: 'integer' },
      ).row.n,
    ).toBe(9007199254740993n);
  });
});

describe('text and default', () => {
  it('trims and changes case, on strings only', () => {
    expect(
      run(
        { email: '  Ada@Example.COM ', n: 5 },
        { kind: 'text', column: 'email', op: 'trim' },
        { kind: 'text', column: 'email', op: 'lower' },
        { kind: 'text', column: 'n', op: 'upper' },
      ).row,
    ).toEqual({ email: 'ada@example.com', n: 5 });
  });

  it('fills in a missing or NULL value, and leaves a present one — even a falsy one — alone', () => {
    const d = { kind: 'default', column: 'status', value: 'new' };
    expect(run({ id: 1 }, d).row).toEqual({ id: 1, status: 'new' });
    expect(run({ status: null }, d).row.status).toBe('new');
    expect(run({ status: '' }, d).row.status).toBe('');
    expect(run({ status: 0 }, { ...d, value: 7 }).row.status).toBe(0);
  });
});

describe('set: a computed column', () => {
  it('builds a value from other columns', () => {
    const { row } = run(
      { first: 'Ada', last: 'Lovelace' },
      { kind: 'set', column: 'full_name', template: '{{first}} {{last}}' },
      { kind: 'set', column: 'source', template: '{{$table}}' },
      { kind: 'set', column: 'synced_at', template: '{{$now}}' },
    );
    expect(row).toMatchObject({
      full_name: 'Ada Lovelace',
      source: 'users',
      synced_at: ctx.now,
    });
  });

  it('a template that is one token copies the value with its type', () => {
    const { row } = run(
      { doc: { a: 1 }, n: 5 },
      { kind: 'set', column: 'copy', template: '{{doc}}' },
      { kind: 'set', column: 'm', template: '{{ n }}' },
    );
    expect(row.copy).toEqual({ a: 1 });
    expect(row.m).toBe(5);
  });

  it('sees what the steps before it did — order is the point', () => {
    const { row } = run(
      { email: ' Ada@Example.com ' },
      { kind: 'text', column: 'email', op: 'trim' },
      { kind: 'text', column: 'email', op: 'lower' },
      { kind: 'set', column: 'email_hash', template: '{{email}}' },
      { kind: 'mask', column: 'email_hash', mode: 'hash' },
      {
        kind: 'mask',
        column: 'email',
        mode: 'partial',
        keepStart: 1,
        keepEnd: 4,
      },
    );
    expect(row.email_hash).toBe(ctx.hash('ada@example.com'));
    expect(row.email).toBe('a**********.com');
  });

  it('a missing column is empty text and a warning, not "undefined"', () => {
    const { row, warnings } = run(
      { a: 1 },
      { kind: 'set', column: 'x', template: 'v={{nope}}' },
    );
    expect(row.x).toBe('v=');
    expect(warnings).toEqual(['set x: no column "nope"']);
  });

  it('cannot reach into the prototype, as a source or as a target', () => {
    const { row } = run(
      { a: 1 },
      { kind: 'set', column: 'x', template: '{{constructor}}{{__proto__}}' },
    );
    expect(row.x).toBe('');
    const polluted = run(
      { a: 1 },
      { kind: 'set', column: '__proto__', template: 'x' },
    ).row;
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('in general', () => {
  it('never modifies the row it was given, and is free when there is nothing to do', () => {
    const row = { id: 1, email: 'a@b.c' };
    const out = run(row, { kind: 'mask', column: 'email', mode: 'redact' }).row;
    expect(row.email).toBe('a@b.c');
    expect(out).not.toBe(row);
    expect(applyColumnTransforms(row, [], ctx).row).toBe(row);
    expect(applyColumnTransforms(row, undefined, ctx).row).toBe(row);
  });

  it('a column that is not in the row is left out, not invented', () => {
    expect(
      run(
        { id: 1 },
        { kind: 'mask', column: 'email', mode: 'redact' },
        { kind: 'cast', column: 'n', to: 'number' },
      ).row,
    ).toEqual({ id: 1 });
  });

  it('leaves the "not sent" marker alone: there is no value to transform', () => {
    const UNCHANGED = Symbol.for('syncle.unchanged');
    const { row } = run(
      { id: 1, body: UNCHANGED },
      { kind: 'mask', column: 'body', mode: 'hash' },
      { kind: 'cast', column: 'body', to: 'string' },
      { kind: 'set', column: 'preview', template: '{{body}}' },
    );
    expect(row.body).toBe(UNCHANGED);
    expect(row.preview).toBe('');
  });

  it('on a delete, masks the key — and invents nothing for a row that is being removed', () => {
    // the destination holds the HASHED e-mail as its key. a delete that arrives
    // with the plain one would look for a row that was never there
    const transforms = [
      { kind: 'mask', column: 'email', mode: 'hash' },
      { kind: 'set', column: 'synced_at', template: '{{$now}}' },
      { kind: 'default', column: 'status', value: 'new' },
    ].map(parse);
    const { row } = applyColumnTransforms(
      { email: 'ada@example.com' },
      transforms,
      { ...ctx, keysOnly: true },
    );
    expect(row).toEqual({ email: ctx.hash('ada@example.com') });
  });
});

describe('what a set of transforms reads and adds', () => {
  const transforms = [
    { kind: 'mask', column: 'email', mode: 'hash' },
    {
      kind: 'set',
      column: 'full_name',
      template: '{{first}} {{last}} {{$now}}',
    },
    { kind: 'default', column: 'status', value: 'new' },
    { kind: 'set', column: 'first', template: 'x' },
  ].map(parse);

  it('reads', () => {
    expect([...columnsRead(transforms)].sort()).toEqual([
      'email',
      'first',
      'last',
      'status',
    ]);
  });

  it('adds only names the source does not have', () => {
    expect(columnsAdded(transforms, ['email', 'first', 'last'])).toEqual([
      'full_name',
      'status',
    ]);
  });
});

describe('the schema', () => {
  it('fills in the defaults a mask needs', () => {
    expect(parse({ kind: 'mask', column: 'c', mode: 'partial' })).toMatchObject(
      { keepStart: 0, keepEnd: 4, fill: '*' },
    );
  });

  it('refuses what it does not know, rather than ignoring it', () => {
    for (const bad of [
      { kind: 'eval', column: 'c', code: '1+1' },
      { kind: 'mask', column: 'c', mode: 'rot13' },
      { kind: 'cast', column: 'c', to: 'uuid' },
      { kind: 'mask', column: '', mode: 'hash' },
      { kind: 'set', column: 'c' },
    ]) {
      expect(
        columnTransformSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
});

describe('what a transformed column is typed as', () => {
  const t = (...list: unknown[]) => list.map(parse);

  it('a hidden value is text, whatever it was', () => {
    for (const mode of ['redact', 'partial', 'hash']) {
      expect(
        transformedType(t({ kind: 'mask', column: 'id', mode }), 'id'),
      ).toBe('text');
    }
    // dropping the value keeps the column what it was
    expect(
      transformedType(t({ kind: 'mask', column: 'id', mode: 'null' }), 'id'),
    ).toBeNull();
  });

  it('a cast is what it was cast to', () => {
    expect(
      transformedType(t({ kind: 'cast', column: 'c', to: 'integer' }), 'c'),
    ).toBe('bigint');
    expect(
      transformedType(t({ kind: 'cast', column: 'c', to: 'date' }), 'c'),
    ).toBe('timestamptz');
    expect(
      transformedType(t({ kind: 'cast', column: 'c', to: 'json' }), 'c'),
    ).toBe('jsonb');
  });

  it('the last word wins: cast to a number, then hashed, is text', () => {
    expect(
      transformedType(
        t(
          { kind: 'cast', column: 'c', to: 'number' },
          { kind: 'mask', column: 'c', mode: 'hash' },
        ),
        'c',
      ),
    ).toBe('text');
  });

  it('built text is text; a copy is whatever it copies; untouched is untouched', () => {
    expect(
      transformedType(
        t({ kind: 'set', column: 'c', template: '{{a}}-{{b}}' }),
        'c',
      ),
    ).toBe('text');
    expect(
      transformedType(t({ kind: 'set', column: 'c', template: '{{a}}' }), 'c'),
    ).toBeNull();
    expect(
      transformedType(t({ kind: 'text', column: 'c', op: 'trim' }), 'c'),
    ).toBeNull();
    expect(
      transformedType(t({ kind: 'mask', column: 'other', mode: 'hash' }), 'c'),
    ).toBeNull();
    expect(transformedType(undefined, 'c')).toBeNull();
  });

  it('a copy is typed like its origin AS IT IS AT THAT STEP, not as it ends up', () => {
    // price is copied, and only then hashed: the copy still holds the number
    const copyThenHash = t(
      { kind: 'set', column: 'price_was', template: '{{ price }}' },
      { kind: 'mask', column: 'price', mode: 'hash' },
    );
    expect(copiedColumn(copyThenHash, 'price_was')).toBe('price');
    expect(transformedType(copyThenHash, 'price_was')).toBeNull();
    expect(transformedType(copyThenHash, 'price')).toBe('text');

    // hashed first, then copied: the copy holds the hash
    const hashThenCopy = t(
      { kind: 'mask', column: 'price', mode: 'hash' },
      { kind: 'set', column: 'price_key', template: '{{price}}' },
    );
    expect(transformedType(hashThenCopy, 'price_key')).toBe('text');
    expect(copiedColumn(hashThenCopy, 'price_key')).toBeNull();

    // a copy of a copy is a copy of the first
    const chain = t(
      { kind: 'set', column: 'b', template: '{{a}}' },
      { kind: 'set', column: 'c', template: '{{b}}' },
    );
    expect(copiedColumn(chain, 'c')).toBe('a');
    // and a cast on the copy is the copy's own business
    const castCopy = t(
      { kind: 'set', column: 'b', template: '{{a}}' },
      { kind: 'cast', column: 'b', to: 'string' },
    );
    expect(transformedType(castCopy, 'b')).toBe('text');
    expect(copiedColumn(castCopy, 'b')).toBeNull();
  });

  it('{{$now}} and {{$table}} are text, not copies of a column called "$now"', () => {
    const stamped = t({
      kind: 'set',
      column: 'synced_at',
      template: '{{$now}}',
    });
    expect(transformedType(stamped, 'synced_at')).toBe('text');
    expect(copiedColumn(stamped, 'synced_at')).toBeNull();
    // cast, it is a timestamp
    expect(
      transformedType(
        [...stamped, parse({ kind: 'cast', column: 'synced_at', to: 'date' })],
        'synced_at',
      ),
    ).toBe('timestamptz');
  });

  it('knows which columns a step can empty: NOT NULL at the source means nothing for those', () => {
    const steps = t(
      { kind: 'mask', column: 'ssn', mode: 'null' },
      { kind: 'cast', column: 'amount', to: 'number', onError: 'null' },
      { kind: 'cast', column: 'strict', to: 'number' },
      { kind: 'cast', column: 'kept', to: 'number', onError: 'keep' },
      { kind: 'mask', column: 'card', mode: 'redact' },
      { kind: 'default', column: 'tier', value: null },
    );
    expect(canBecomeNull(steps, 'ssn')).toBe(true);
    expect(canBecomeNull(steps, 'amount')).toBe(true);
    expect(canBecomeNull(steps, 'strict')).toBe(false);
    expect(canBecomeNull(steps, 'kept')).toBe(false);
    expect(canBecomeNull(steps, 'card')).toBe(false);
    // a default of NULL only ever writes NULL where there already was none
    expect(canBecomeNull(steps, 'tier')).toBe(false);
    expect(canBecomeNull(undefined, 'ssn')).toBe(false);
  });
});
