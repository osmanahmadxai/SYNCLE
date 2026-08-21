import { quoteIdent, type DatabaseEngine } from '@syncle/core';

// quoting rules live in core next to the adapters that own the dialects —
// re-exported here so existing imports keep working
export { quoteIdent };

/**
 * build a safe, dialect-quoted `SELECT *` for a relation. backs the
 * "open in query editor" action so users don't have to remember quoting rules
 * (e.g. PostgreSQL folding unquoted `User` to `user`)
 */
export function buildSelect(
  engine: DatabaseEngine,
  table: string,
  schema?: string,
  limit = 100,
): string {
  const target = schema
    ? `${quoteIdent(engine, schema)}.${quoteIdent(engine, table)}`
    : quoteIdent(engine, table);
  return `SELECT * FROM ${target} LIMIT ${limit};`;
}
