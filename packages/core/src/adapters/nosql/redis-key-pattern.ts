/**
 * the one filter Redis can apply is a glob on the key, and a bridge's source
 * filters are (column, operator, value). this is how the second becomes the
 * first — in ONE place, because two readers have to agree on it: the adapter's
 * `browse` (a replay, the copy a change-stream bridge makes of its keys) and the
 * change stream itself. they did not: `browse` read any filter on `key` as
 * "contains", the stream read it as an exact glob, so a bridge filtered to
 * `user:` copied the keys that contain it and then followed a key named
 * exactly that.
 *
 *   equals       the value is the glob, as written: `user:*`, `session:??`
 *   contains     *value*
 *   starts with  value*
 *   ends with    *value
 *
 * anything else Redis has no way to ask for, and reads as "every key".
 */
import type { FilterSpec } from '../types';

export function redisKeyPattern(
  filters: readonly FilterSpec[] | undefined,
): string {
  const filter = filters?.find((f) => f.column === 'key');
  if (!filter || typeof filter.value !== 'string' || filter.value === '')
    return '*';
  switch (filter.operator) {
    case 'eq':
      return filter.value;
    case 'contains':
      return `*${filter.value}*`;
    case 'startsWith':
      return `${filter.value}*`;
    case 'endsWith':
      return `*${filter.value}`;
    default:
      return '*';
  }
}

/** Redis's MATCH, for a key that arrives as an event and was never SCANned: `*`, `?`, `[a-c]`, `[^x]`, `\` */
export function redisGlobMatch(glob: string, value: string): boolean {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else if (ch === '\\' && i + 1 < glob.length) re += escapeRegExp(glob[++i]!);
    else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close < 0) re += '\\[';
      else {
        let body = glob.slice(i + 1, close);
        const negate = body.startsWith('^');
        if (negate) body = body.slice(1);
        re += `[${negate ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
        i = close;
      }
    } else re += escapeRegExp(ch);
  }
  return new RegExp(`${re}$`).test(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
