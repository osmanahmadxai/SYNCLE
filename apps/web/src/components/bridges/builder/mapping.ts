/**
 * the two pure edges of the builder: an existing bridge → a draft (edit-mode
 * hydration) and a draft → the input DTO the API expects (save). kept free of
 * React so they can be unit-tested directly.
 */
import {
  columnsAdded,
  type Bridge,
  type BridgeInputDTO,
  type ColumnTransform,
  type FilterSpec,
  type SortSpec,
} from '@syncle/core';
import {
  blankDbTarget,
  blankDestination,
  initialDraft,
  type BuilderDraft,
  VALUELESS,
  draftId,
  type FilterOperator,
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
    // the row selection is the FIRST `in` filter; it is rebuilt from the grid
    const inFilter = h.source.filters?.find((f) => f.operator === 'in');
    if (inFilter && Array.isArray(inFilter.value)) {
      d.mode = 'selected';
      d.selectedKeys = new Map(
        (inFilter.value as unknown[]).map((v) => [String(v), v]),
      );
    }
    for (const f of h.source.filters ?? []) {
      if (f === inFilter) continue;
      const editable =
        f.operator !== 'in' &&
        (VALUELESS.has(f.operator) ||
          ['string', 'number', 'boolean'].includes(typeof f.value));
      if (editable) {
        d.filters.push({
          id: draftId(),
          column: f.column,
          operator: f.operator as FilterOperator,
          value: VALUELESS.has(f.operator as FilterOperator) ? '' : String(f.value),
        });
      } else {
        // no row for it in the editor: kept exactly as it is
        d.extraFilters.push(f);
      }
    }
  }
  d.transforms = (h.transform.columns ?? []).map((t) => ({ ...t, id: draftId() }));
  d.template = h.transform.template ?? '{{$row}}';
  d.rename = h.transform.rename;
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
    // no control for these: they ride through the edit as they are
    d.maxPerPoll = h.trigger.maxPerPoll;
    if (h.trigger.strategy.strategy === 'snapshot')
      d.snapshotMaxTracked = h.trigger.strategy.maxTracked;
    if (h.trigger.strategy.strategy === 'timestamp')
      d.lookbackMs = h.trigger.strategy.lookbackMs;
  } else if (h.trigger.kind === 'cdc') {
    d.syncMode = 'live';
    d.triggerKind = 'cdc';
    d.cdcOps = new Set(h.trigger.operations);
    d.cdcStartFrom = h.trigger.startFrom ?? 'now';
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
      onDelete: t.onDelete ?? 'delete',
      softDeleteColumn: t.softDelete?.column ?? 'deleted_at',
      softDeleteValue: t.softDelete?.value ?? 'timestamp',
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
    onSchemaChange: h.delivery.onSchemaChange ?? 'stop',
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
  /**
   * what kind of value each column holds ('number', 'boolean', …), from a
   * sample row: a filter typed as "42" on a numeric column is sent as 42
   */
  columnTypes?: Record<string, string>;
}

/** the value of a filter as the API should get it: a number or a boolean where the column is one */
export function coerceFilterValue(text: string, columnType: string | undefined): string | number | boolean {
  const trimmed = text.trim();
  if ((columnType === 'number' || columnType === 'bigint') && trimmed !== '' && Number.isFinite(Number(trimmed))) {
    // beyond 2^53 a number would be rounded on the way; the engines compare text
    // to a numeric column correctly, so such a value stays text
    const n = Number(trimmed);
    return Number.isSafeInteger(n) || !/^-?\d+$/.test(trimmed) ? n : trimmed;
  }
  if (columnType === 'boolean' && /^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  return text;
}

/**
 * the draft's steps as the API takes them: without the editor's row ids, and
 * with a default that was TYPED for a numeric or boolean column sent as a number
 * or a boolean — "0" in a text box means 0 there, and MongoDB would store the text
 */
export function draftTransforms(
  draft: Pick<BuilderDraft, 'transforms'>,
  columnTypes?: Record<string, string>,
): ColumnTransform[] {
  return draft.transforms.map(({ id: _id, ...rest }) => {
    const step = rest as ColumnTransform;
    return step.kind === 'default' && typeof step.value === 'string'
      ? { ...step, value: coerceFilterValue(step.value, columnTypes?.[step.column]) }
      : step;
  });
}

/** turn the draft into the exact payload the create/update endpoints expect */
export function buildInput(
  draft: BuilderDraft,
  ctx: BuildInputContext,
): BridgeInputDTO {
  const transforms = draftTransforms(draft, ctx.columnTypes);
  // columns the transforms ADD (a computed column, a default for a new name)
  // are part of the row from here on, like any other included column
  const includedList = [
    ...ctx.columns.filter((n) => draft.included.has(n)),
    ...columnsAdded(transforms, ctx.columns),
  ];

  const filters: FilterSpec[] = [];
  if (draft.mode === 'selected' && ctx.singlePk) {
    filters.push({
      column: ctx.singlePk,
      operator: 'in',
      value: [...draft.selectedKeys.values()],
    });
  }
  for (const f of draft.filters) {
    if (!f.column) continue;
    if (VALUELESS.has(f.operator)) filters.push({ column: f.column, operator: f.operator });
    // a condition with nothing to compare against is not a condition yet
    else if (f.value.trim() !== '') {
      filters.push({
        column: f.column,
        operator: f.operator,
        value: coerceFilterValue(f.value, ctx.columnTypes?.[f.column]),
      });
    }
  }
  filters.push(...draft.extraFilters);
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

  const allIncluded =
    ctx.columns.every((n) => draft.included.has(n)) &&
    columnsAdded(transforms, ctx.columns).length === 0;

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
            onDelete: t.onDelete,
            // kept only while it means something: a marker column left over from
            // an earlier choice is not part of a target that removes its rows
            softDelete:
              t.onDelete === 'soft'
                ? { column: t.softDeleteColumn.trim(), value: t.softDeleteValue }
                : undefined,
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
      template: draft.template || '{{$row}}',
      fields: allIncluded ? undefined : includedList,
      rename: draft.rename,
      wrapKey: draft.wrapKey || undefined,
      columns: transforms.length ? transforms : undefined,
    },
    delivery: {
      batchSize: draft.delivery.batchSize,
      maxAttempts: draft.delivery.maxAttempts,
      minDelayMs: draft.delivery.minDelayMs,
      timeoutMs: draft.delivery.timeoutMs,
      onError: draft.delivery.onError,
      onSchemaChange: draft.delivery.onSchemaChange,
      backoffMs: 500,
      backoffMaxMs: 30000,
      pageSize: 200,
    },
    trigger:
      draft.triggerKind === 'cdc'
        ? { kind: 'cdc', operations: [...draft.cdcOps], startFrom: draft.cdcStartFrom }
        : draft.triggerKind === 'watch'
          ? {
              kind: 'watch',
              strategy:
                draft.watchStrategy === 'snapshot'
                  ? { strategy: 'snapshot', maxTracked: draft.snapshotMaxTracked }
                  : draft.watchStrategy === 'timestamp'
                    ? {
                        strategy: 'timestamp',
                        column: draft.watchColumn,
                        lookbackMs: draft.lookbackMs,
                      }
                    : { strategy: 'increment', column: draft.watchColumn },
              pollIntervalMs: Math.max(1000, Math.round(draft.pollSeconds * 1000)),
              startFrom: draft.watchStartFrom,
              maxPerPoll: draft.maxPerPoll,
            }
          : { kind: 'replay' },
    enabled: draft.enabled,
  };
}
