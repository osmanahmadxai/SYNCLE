/**
 * The editor's dropdowns, held to the schema they write and to the translations
 * they are shown with. None of the three knows about the other two.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgeInputSchema, columnTransformSchema } from '@syncle/core';
import { FILTER_OPERATORS, type DraftFilter } from './draft';
import {
  CAST_ERRORS,
  CAST_TARGETS,
  MASK_MODES,
  TEXT_OPS,
  TRANSFORM_KINDS,
  blankTransform,
  incompleteFilter,
  incompleteTransform,
} from './transform-options';

type Messages = { [key: string]: string | Messages };
const messages = JSON.parse(
  readFileSync(join(__dirname, '../../../messages/en.json'), 'utf8'),
) as Record<string, Record<string, Record<string, string>>>;

/** the values a field of one kind of step accepts, read off the zod schema itself */
function accepted(kind: string, field: string): string[] {
  const option = columnTransformSchema.options.find(
    (o) => o.shape.kind.value === kind,
  )!;
  let type: unknown = (option.shape as Record<string, unknown>)[field];
  // a field with a default is wrapped; the enum is inside
  while (type && typeof type === 'object' && 'removeDefault' in type) {
    type = (type as { removeDefault(): unknown }).removeDefault();
  }
  return [...(type as { options: string[] }).options].sort();
}

describe('what the transforms editor offers', () => {
  it('is every kind the schema has, and no other', () => {
    const kinds = columnTransformSchema.options
      .map((o) => o.shape.kind.value)
      .sort();
    expect([...TRANSFORM_KINDS].sort()).toEqual(kinds);
  });

  it.each([
    ['mask', 'mode', MASK_MODES],
    ['cast', 'to', CAST_TARGETS],
    ['cast', 'onError', CAST_ERRORS],
    ['text', 'op', TEXT_OPS],
  ] as const)(
    '%s.%s lists exactly what the schema accepts',
    (kind, field, offered) => {
      expect([...offered].sort()).toEqual(accepted(kind, field));
    },
  );

  it.each([
    ['kind', TRANSFORM_KINDS],
    ['mask', MASK_MODES],
    ['cast', CAST_TARGETS],
    ['castError', CAST_ERRORS],
    ['text', TEXT_OPS],
  ] as const)('every %s choice has a label', (group, offered) => {
    const labels = messages.builderTransforms![group] as unknown as Record<
      string,
      string
    >;
    expect(Object.keys(labels).sort()).toEqual([...offered].sort());
  });

  it('every filter operator has a label, and the row selection’s `in` is not offered', () => {
    expect(Object.keys(messages.builderFilters!.op!).sort()).toEqual(
      [...FILTER_OPERATORS].sort(),
    );
    expect(FILTER_OPERATORS).not.toContain('in');
  });

  it('a fresh step of every kind is one the API takes, once it names a column', () => {
    for (const kind of TRANSFORM_KINDS) {
      const step = { ...blankTransform(kind, 'email'), column: 'email' };
      expect(columnTransformSchema.safeParse(step).success, kind).toBe(true);
    }
    // a computed column is usually a NEW one, so it starts without a name…
    expect(blankTransform('set', 'email').column).toBe('');
    // …and the schema would refuse it, which is why the builder does not let it be saved
    expect(
      columnTransformSchema.safeParse(blankTransform('set', 'email')).success,
    ).toBe(false);
  });

  it('the whole bridge schema knows the key the builder writes them under', () => {
    const shape = bridgeInputSchema.shape.transform;
    expect(
      JSON.stringify(
        shape.parse({ columns: [blankTransform('text', 'a')] }).columns,
      ),
    ).toBe(JSON.stringify([{ kind: 'text', column: 'a', op: 'trim' }]));
  });
});

describe('what blocks a save', () => {
  const filter = (f: Partial<DraftFilter>): DraftFilter => ({
    id: 'f',
    column: 'age',
    operator: 'eq',
    value: '1',
    ...f,
  });

  it('a condition with no column, or no value where one is compared', () => {
    expect(incompleteFilter(filter({}))).toBe(false);
    expect(incompleteFilter(filter({ value: '   ' }))).toBe(true);
    expect(incompleteFilter(filter({ column: '' }))).toBe(true);
    // "is empty" compares against nothing
    expect(incompleteFilter(filter({ operator: 'isNull', value: '' }))).toBe(
      false,
    );
    expect(incompleteFilter(filter({ operator: 'notNull', value: '' }))).toBe(
      false,
    );
  });

  it('a step that does not say which column', () => {
    expect(
      incompleteTransform({ id: 't', ...blankTransform('set', 'x') }),
    ).toBe(true);
    expect(
      incompleteTransform({ id: 't', kind: 'set', column: ' ', template: 'x' }),
    ).toBe(true);
    expect(
      incompleteTransform({ id: 't', ...blankTransform('mask', 'email') }),
    ).toBe(false);
  });
});
