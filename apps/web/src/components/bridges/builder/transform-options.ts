/**
 * what the transforms editor offers, and what a fresh step of each kind looks
 * like. kept out of the component so a test can hold the lists to the schema in
 * @syncle/core: a mode added there and forgotten here would otherwise be a
 * choice nobody can make, and one added here only, a save the API refuses.
 */
import type { ColumnTransform } from '@syncle/core';
import { VALUELESS, type DraftFilter, type DraftTransform } from './draft';

export type TransformKind = ColumnTransform['kind'];
type Of<K extends TransformKind> = Extract<ColumnTransform, { kind: K }>;

export const TRANSFORM_KINDS: TransformKind[] = [
  'mask',
  'cast',
  'text',
  'default',
  'set',
];
export const MASK_MODES: Of<'mask'>['mode'][] = [
  'partial',
  'redact',
  'hash',
  'null',
];
export const CAST_TARGETS: Of<'cast'>['to'][] = [
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'json',
];
export const CAST_ERRORS: Of<'cast'>['onError'][] = ['fail', 'null', 'keep'];
export const TEXT_OPS: Of<'text'>['op'][] = ['trim', 'lower', 'upper'];

/** a sensible blank step of a kind. a computed column starts without a name: it is usually a new one */
export function blankTransform(
  kind: TransformKind,
  column: string,
): ColumnTransform {
  switch (kind) {
    case 'mask':
      return {
        kind,
        column,
        mode: 'partial',
        keepStart: 0,
        keepEnd: 4,
        fill: '*',
      };
    case 'cast':
      return { kind, column, to: 'string', onError: 'fail' };
    case 'text':
      return { kind, column, op: 'trim' };
    case 'default':
      return { kind, column, value: '' };
    case 'set':
      return { kind, column: '', template: '' };
  }
}

/**
 * a condition with nothing to compare against. NOT saved as "no condition":
 * that would send every row of the table where the author meant a few
 */
export const incompleteFilter = (f: DraftFilter): boolean =>
  !f.column || (!VALUELESS.has(f.operator) && f.value.trim() === '');

/** a step that does not say which column it is about */
export const incompleteTransform = (t: DraftTransform): boolean =>
  t.column.trim() === '';
