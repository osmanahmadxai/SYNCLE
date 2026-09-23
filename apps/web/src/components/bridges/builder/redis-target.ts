/**
 * a target in Redis, in the builder: how a row becomes a key.
 *
 * the rules are the API's (core's `redisTargetSchema`); what is here is the
 * part a form needs — which of them is broken right now, in words the form can
 * translate, and a key to start from
 */
import { redisKeyColumns } from '@syncle/core';
import type { DbTarget } from './draft';

export type RedisTargetProblem =
  | 'keyEmpty'
  | 'keyNoColumn'
  | 'keyUnknownColumn'
  | 'valueColumn'
  | 'ttl';

/** `orders:{{id}}`: the source table as the prefix, the row's key as the rest */
export function defaultKeyTemplate(
  sourceTable: string | null | undefined,
  keyColumn: string | null | undefined,
  columns: readonly string[],
): string {
  const column = keyColumn || columns[0] || 'id';
  const prefix = (sourceTable ?? '').trim().replace(/[^\w.-]+/g, '_') || 'row';
  return `${prefix}:{{${column}}}`;
}

/**
 * what is wrong with the target as it stands, or null. `columns` are the names
 * the target receives (after renames)
 */
export function redisTargetProblem(
  target: Pick<
    DbTarget,
    'redisKeyTemplate' | 'redisType' | 'redisValueColumn' | 'redisTtlSeconds'
  >,
  columns: readonly string[],
): { problem: RedisTargetProblem; column?: string } | null {
  const template = target.redisKeyTemplate.trim();
  if (!template) return { problem: 'keyEmpty' };
  const used = redisKeyColumns(template);
  if (used.length === 0) return { problem: 'keyNoColumn' };
  const unknown = used.find((c) => !columns.includes(c));
  if (unknown !== undefined)
    return { problem: 'keyUnknownColumn', column: unknown };
  if (
    target.redisType === 'string' &&
    !columns.includes(target.redisValueColumn)
  )
    return { problem: 'valueColumn' };
  const ttl = target.redisTtlSeconds;
  if (ttl !== null && (!Number.isInteger(ttl) || ttl < 1))
    return { problem: 'ttl' };
  return null;
}
