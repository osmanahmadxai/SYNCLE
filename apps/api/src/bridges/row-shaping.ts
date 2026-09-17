/**
 * a bridge's column transforms (masking, casts, computed columns), applied to
 * rows on their way out — once, in one place, whatever brought them: a replay, a
 * poll, a change stream, a dead-letter retry, the dry run.
 *
 * what is stored about a row BEFORE delivery (its keys, a parked dead letter)
 * is the row as the source has it, so that a retry can find it there again and
 * shapes it afresh. what is recorded OF a delivery is the shaped row: a masked
 * column must not reappear in the timeline.
 */
import { createHash } from 'node:crypto';
import { applyColumnTransforms, type CdcOperation } from '@syncle/core';
import type { ResolvedBridge } from './bridges.types';

type Row = Record<string, unknown>;

const sha256 = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

export function shapeRows(
  bridge: ResolvedBridge,
  rows: Row[],
  ctx: { table: string; now: string; op?: CdcOperation },
): { rows: Row[]; warnings: string[]; errors: string[] } {
  const transforms = bridge.transform.columns;
  if (!transforms?.length || ctx.op === 'truncate')
    return { rows, warnings: [], errors: [] };
  const warnings = new Set<string>();
  const errors = new Set<string>();
  const shaped = rows.map((row) => {
    const result = applyColumnTransforms(row, transforms, {
      table: ctx.table,
      now: ctx.now,
      hash: sha256,
      // a delete's row is often only its key: mask it like the key that was
      // written, and compute nothing for a row that is going away
      keysOnly: ctx.op === 'delete',
    });
    for (const w of result.warnings) warnings.add(w);
    for (const e of result.errors) errors.add(e);
    return result.row;
  });
  return { rows: shaped, warnings: [...warnings], errors: [...errors] };
}
