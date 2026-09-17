import type { DatabaseEngine } from '@syncle/core';

/**
 * values for an `IN`, each once. a document store matches by TYPE as well as by
 * value, and a key that went through a SQL destination comes back as text: the
 * number it may have been is asked for beside it
 */
export function lookupValues(
  values: unknown[],
  engine?: DatabaseEngine,
): unknown[] {
  const out = new Map<string, unknown>();
  for (const value of values) {
    out.set(`${typeof value}:${String(value)}`, value);
    if (
      engine === 'mongodb' &&
      typeof value === 'string' &&
      /^-?\d{1,15}$/.test(value) &&
      String(Number(value)) === value
    ) {
      out.set(`number:${value}`, Number(value));
    }
  }
  return [...out.values()];
}
