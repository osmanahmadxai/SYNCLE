/**
 * the two pure edges of the builder: an existing bridge → a draft (edit-mode
 * hydration) and a draft → the input DTO the API expects (save). kept free of
 * React so they can be unit-tested directly.
 */
import type { Bridge, BridgeInputDTO, FilterSpec, SortSpec } from '@syncle/core';
import {
  blankDbTarget,
  blankDestination,
  initialDraft,
  type BuilderDraft,
} from './draft';

/** hydrate a draft from an existing bridge (edit mode) */
export function loadBridge(h: Bridge): BuilderDraft {
  const d = initialDraft();
  d.name = h.name;
  d.connectionId = h.source.connectionId;
  d.database = h.source.database ?? '';
  d.mode = 'all';
  d.selectedKeys = new Map();
  if (h.source.kind === 'table') {
    d.schema = h.source.schema ?? '';
    d.table = h.source.table;
    const inFilter = h.source.filters?.find((f) => f.operator === 'in');
    if (inFilter && Array.isArray(inFilter.value)) {
      d.mode = 'selected';
      d.selectedKeys = new Map(
        (inFilter.value as unknown[]).map((v) => [String(v), v]),
      );
    }
  }
  // applied when the table's columns load (subset = pinned fields, none = all)
  d.fieldsPref = h.transform.fields ?? null;
  d.wrapKey = h.transform.wrapKey ?? '';
  if (h.trigger.kind === 'watch') {
    d.syncMode = 'live';
    d.triggerKind = 'watch';
    d.watchStrategy = h.trigger.strategy.strategy;
    d.watchColumn =
      h.trigger.strategy.strategy === 'snapshot' ? '' : h.trigger.strategy.column;
    d.pollSeconds = Math.round(h.trigger.pollIntervalMs / 1000);
    d.watchStartFrom = h.trigger.startFrom;
  } else if (h.trigger.kind === 'cdc') {
    d.syncMode = 'live';
    d.triggerKind = 'cdc';
    d.cdcOps = new Set(h.trigger.operations);
  } else {
    d.syncMode = 'oneTime';
    d.triggerKind = 'replay';
  }
  if (h.destination.kind === 'database') {
    d.destKind = 'database';
    d.dbTargets = h.destination.targets.map((t) => ({
      connectionId: t.connectionId,
      database: t.database ?? '',
      schema: t.schema ?? '',
      table: t.table,
      writeMode: t.writeMode,
      keyColumns: t.keyColumns,
      createMissingTable: t.createMissingTable,
      renames: Object.fromEntries(
        t.mapping
          .filter((m) => m.source !== m.target)
          .map((m) => [m.source, m.target]),
      ),
    }));
    d.dest = blankDestination();
  } else {
    d.destKind = 'http';
    d.dbTargets = [blankDbTarget()];
    d.dest = {
      url: h.destination.url,
      method: h.destination.method,
      authType: h.destination.auth.type,
      authToken:
        h.destination.auth.type === 'bearer' ? h.destination.auth.token : '',
      authHeaderName:
        h.destination.auth.type === 'header' ? h.destination.auth.name : '',
      authHeaderValue:
        h.destination.auth.type === 'header' ? h.destination.auth.value : '',
      headers: Object.entries(h.destination.headers ?? {}).map(
        ([key, value]) => ({ key, value }),
      ),
      idempotency: h.destination.idempotency,
    };
  }
  d.delivery = {
    batchSize: h.delivery.batchSize,
    maxAttempts: h.delivery.maxAttempts,
    minDelayMs: h.delivery.minDelayMs,
    timeoutMs: h.delivery.timeoutMs,
    onError: h.delivery.onError,
  };
  d.enabled = h.enabled;
  return d;
}

/** the bits of live table metadata the save payload depends on */
export interface BuildInputContext {
  /** every column name of the source table, in table order */
  columns: string[];
  /** the table's single-column primary key, or null */
  singlePk: string | null;
  /** localized name used when the draft's name is blank */
  fallbackName: string;
}

/** turn the draft into the exact payload the create/update endpoints expect */
export function buildInput(
  draft: BuilderDraft,
  ctx: BuildInputContext,
): BridgeInputDTO {
  const includedList = ctx.columns.filter((n) => draft.included.has(n));

  const filters: FilterSpec[] = [];
  if (draft.mode === 'selected' && ctx.singlePk) {
    filters.push({
      column: ctx.singlePk,
      operator: 'in',
      value: [...draft.selectedKeys.values()],
    });
  }
  const sort: SortSpec[] | undefined = ctx.singlePk
    ? [{ column: ctx.singlePk, direction: 'asc' }]
    : undefined;

  const auth: Extract<
    BridgeInputDTO['destination'],
    { kind: 'http' }
  >['auth'] =
    draft.dest.authType === 'bearer'
      ? { type: 'bearer', token: draft.dest.authToken }
      : draft.dest.authType === 'header'
        ? {
            type: 'header',
            name: draft.dest.authHeaderName,
            value: draft.dest.authHeaderValue,
          }
        : { type: 'none' };
  const headerEntries = draft.dest.headers
    .filter((h) => h.key.trim())
    .map((h) => [h.key.trim(), h.value] as const);

  const allIncluded = includedList.length === ctx.columns.length;

  const destination: BridgeInputDTO['destination'] =
    draft.destKind === 'database'
      ? {
          kind: 'database',
          targets: draft.dbTargets.map((t) => ({
            connectionId: t.connectionId,
            database: t.database || undefined,
            schema: t.schema || undefined,
            table: t.table.trim(),
            writeMode: t.writeMode,
            keyColumns: t.keyColumns,
            // always send the full projection so the included-column choice is
            // honored; renames apply where the target name differs
            mapping: includedList.map((s) => ({
              source: s,
              target: (t.renames[s]?.trim() || s),
            })),
            createMissingTable: t.createMissingTable,
          })),
        }
      : {
          kind: 'http',
          url: draft.dest.url.trim(),
          method: draft.dest.method,
          headers: headerEntries.length
            ? Object.fromEntries(headerEntries)
            : undefined,
          auth,
          idempotency: draft.dest.idempotency,
        };

  return {
    name: draft.name.trim() || ctx.fallbackName,
    source: {
      kind: 'table',
      connectionId: draft.connectionId,
      database: draft.database || undefined,
      schema: draft.schema || undefined,
      table: draft.table,
      filters: filters.length ? filters : undefined,
      sort,
    },
    destination,
    transform: {
      template: '{{$row}}',
      fields: allIncluded ? undefined : includedList,
      wrapKey: draft.wrapKey || undefined,
    },
    delivery: {
      batchSize: draft.delivery.batchSize,
      maxAttempts: draft.delivery.maxAttempts,
      minDelayMs: draft.delivery.minDelayMs,
      timeoutMs: draft.delivery.timeoutMs,
      onError: draft.delivery.onError,
      backoffMs: 500,
      backoffMaxMs: 30000,
      pageSize: 200,
    },
    trigger:
      draft.triggerKind === 'cdc'
        ? { kind: 'cdc', operations: [...draft.cdcOps] }
        : draft.triggerKind === 'watch'
          ? {
              kind: 'watch',
              strategy:
                draft.watchStrategy === 'snapshot'
                  ? { strategy: 'snapshot', maxTracked: 50000 }
                  : draft.watchStrategy === 'timestamp'
                    ? {
                        strategy: 'timestamp',
                        column: draft.watchColumn,
                        lookbackMs: 3000,
                      }
                    : { strategy: 'increment', column: draft.watchColumn },
              pollIntervalMs: Math.max(1000, Math.round(draft.pollSeconds * 1000)),
              startFrom: draft.watchStartFrom,
              maxPerPoll: 500,
            }
          : { kind: 'replay' },
    enabled: draft.enabled,
  };
}
