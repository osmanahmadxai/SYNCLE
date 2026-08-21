/**
 * pure SQL dialect helpers shared by the core adapters and the web client.
 * web-safe (no driver imports), so the browser bundle can quote identifiers
 * exactly the way the adapters do — e.g. for "open in query editor" snippets —
 * instead of re-implementing the per-engine rules and drifting.
 */
import type { DatabaseEngine } from './adapters/types';

/** quote an identifier (table/column) safely for the engine's SQL dialect */
export function quoteIdent(engine: DatabaseEngine, identifier: string): string {
  // MySQL backtick-quotes; every other supported SQL dialect uses the
  // standard double-quote form
  return engine === 'mysql'
    ? `\`${identifier.replace(/`/g, '``')}\``
    : `"${identifier.replace(/"/g, '""')}"`;
}
