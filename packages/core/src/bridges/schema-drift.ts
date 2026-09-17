/**
 * a source table that has changed since its bridge was set up.
 *
 * A bridge is built against the columns a table has on the day it is built. The
 * table goes on living. What that used to mean:
 *
 *  - a column the bridge MAPS is dropped, or renamed: every row from then on has
 *    no value for it, and an upsert wrote NULL over the value the destination
 *    had — row by row, as they changed, with every delivery green
 *  - a column is added: nothing; it is not in the mapping, and nobody is told
 *    that the copy is now narrower than the original
 *
 * Both are found by comparing the columns the bridge last saw (its baseline)
 * with the columns the table has now. pure, and browser-safe.
 */
import { columnsRead } from './column-transforms';
import { templateColumns } from './transform';
import type { BridgeInputDTO } from './bridge-config';

export interface SchemaColumn {
  name: string;
  /** the engine's own spelling of the type */
  type: string;
  nullable: boolean;
}

export interface SchemaDrift {
  added: SchemaColumn[];
  removed: SchemaColumn[];
  retyped: Array<{ name: string; from: string; to: string }>;
}

/** a bridge's drift as the API reports it */
export interface BridgeSchemaDrift {
  /** when the columns were last accepted as "what this bridge is built for"; null = never recorded */
  baselineAt: string | null;
  checkedAt: string;
  drift: SchemaDrift | null;
  /**
   * columns the bridge USES that the table no longer has. this is the harmful
   * kind: what stops a bridge whose `onSchemaChange` is not `continue`
   */
  missingUsed: string[];
}

const norm = (type: string): string =>
  type.trim().toLowerCase().replace(/\s+/g, ' ');

export function diffColumns(
  baseline: readonly SchemaColumn[],
  now: readonly SchemaColumn[],
): SchemaDrift | null {
  const before = new Map(baseline.map((c) => [c.name, c]));
  const after = new Map(now.map((c) => [c.name, c]));
  const drift: SchemaDrift = {
    added: now.filter((c) => !before.has(c.name)),
    removed: baseline.filter((c) => !after.has(c.name)),
    retyped: now
      .filter(
        (c) =>
          before.has(c.name) && norm(before.get(c.name)!.type) !== norm(c.type),
      )
      .map((c) => ({
        name: c.name,
        from: before.get(c.name)!.type,
        to: c.type,
      })),
  };
  return drift.added.length || drift.removed.length || drift.retyped.length
    ? drift
    : null;
}

/**
 * the source columns a bridge cannot do without: what it maps by name, keys
 * on, filters and sorts by, reads in a transform, polls by, or pins into a
 * payload — by the field list, or by name in the template. (a target with NO
 * mapping takes the row as it comes: a column that goes is simply no longer
 * written, and the destination keeps what it had.)
 */
export function columnsUsed(
  bridge: Pick<
    BridgeInputDTO,
    'source' | 'destination' | 'transform' | 'trigger'
  >,
): string[] {
  const used = new Set<string>();
  // columns a transform ADDS are not the table's to lose
  const produced = new Set(
    (bridge.transform.columns ?? [])
      .filter((t) => t.kind === 'set' || t.kind === 'default')
      .map((t) => t.column),
  );

  if (bridge.source.kind === 'table') {
    for (const f of bridge.source.filters ?? []) used.add(f.column);
    for (const s of bridge.source.sort ?? []) used.add(s.column);
  }
  for (const name of columnsRead(bridge.transform.columns)) used.add(name);
  if (bridge.destination.kind === 'database') {
    for (const target of bridge.destination.targets) {
      for (const m of target.mapping) used.add(m.source);
      // with no mapping the key columns ARE source columns
      if (target.mapping.length === 0)
        for (const k of target.keyColumns) used.add(k);
    }
  } else {
    for (const field of bridge.transform.fields ?? []) used.add(field);
    for (const name of templateColumns(bridge.transform.template))
      used.add(name);
  }
  if (
    bridge.trigger.kind === 'watch' &&
    bridge.trigger.strategy.strategy !== 'snapshot'
  ) {
    used.add(bridge.trigger.strategy.column);
  }
  for (const name of produced) used.delete(name);
  return [...used].sort();
}

/** one line a person can act on */
export function describeDrift(drift: SchemaDrift): string {
  const parts: string[] = [];
  if (drift.removed.length)
    parts.push(`removed: ${drift.removed.map((c) => c.name).join(', ')}`);
  if (drift.added.length)
    parts.push(
      `added: ${drift.added.map((c) => `${c.name} (${c.type})`).join(', ')}`,
    );
  if (drift.retyped.length)
    parts.push(
      `changed type: ${drift.retyped.map((c) => `${c.name} (${c.from} → ${c.to})`).join(', ')}`,
    );
  return parts.join('; ');
}
