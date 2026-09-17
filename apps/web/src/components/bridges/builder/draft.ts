/**
 * the bridge builder's draft state: one typed object + a reducer, replacing the
 * pile of useState calls the builder used to juggle. every cross-field cascade
 * (changing the connection resets the table, changing the table resets the
 * column/row selections, toggling the sync mode adjusts the trigger, …) lives
 * here so a section can never forget one.
 */
import type { CdcReadiness, ColumnTransform, FilterSpec } from '@syncle/core';

export const PAGE_SIZE = 100;

export type AuthType = 'none' | 'bearer' | 'header';

export interface Destination {
  url: string;
  method: 'POST' | 'PUT' | 'PATCH';
  authType: AuthType;
  authToken: string;
  authHeaderName: string;
  authHeaderValue: string;
  headers: { key: string; value: string }[];
  idempotency: boolean;
}

/** a single database a bridge writes into (UI shape) */
export interface DbTarget {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  writeMode: 'upsert' | 'insert';
  /** target column names that uniquely identify a row (for upsert) */
  keyColumns: string[];
  createMissingTable: boolean;
  /** optional source column → target column renames (default identity) */
  renames: Record<string, string>;
  /** what a DELETE at the source does here: remove the row, mark it, or leave it */
  onDelete: 'delete' | 'soft' | 'ignore';
  /** the target column a soft delete marks the row with, and what with */
  softDeleteColumn: string;
  softDeleteValue: 'timestamp' | 'boolean';
  /**
   * a target in REDIS: `template` = a key per row, built from its columns (a
   * hash, a JSON document or one column's value); `columns` = the row's own
   * `key` and `value` columns, which is all there was before
   */
  redisMode: 'columns' | 'template';
  redisKeyTemplate: string;
  redisType: 'hash' | 'json' | 'string';
  redisValueColumn: string;
  /** seconds after its last write at which the key expires; null = it does not */
  redisTtlSeconds: number | null;
}

export interface Delivery {
  batchSize: number;
  maxAttempts: number;
  minDelayMs: number;
  timeoutMs: number;
  onError: 'continue' | 'abort';
  /** what to do when the source table is no longer the one the bridge was built on */
  onSchemaChange: 'stop' | 'continue' | 'evolve';
}

export function blankDbTarget(): DbTarget {
  return {
    connectionId: '',
    database: '',
    schema: '',
    table: '',
    writeMode: 'upsert',
    keyColumns: [],
    createMissingTable: true,
    renames: {},
    onDelete: 'delete',
    softDeleteColumn: 'deleted_at',
    softDeleteValue: 'timestamp',
    redisMode: 'columns',
    redisKeyTemplate: '',
    redisType: 'hash',
    redisValueColumn: '',
    redisTtlSeconds: null,
  };
}

export function blankDestination(): Destination {
  return {
    url: '',
    method: 'POST',
    authType: 'none',
    authToken: '',
    authHeaderName: '',
    authHeaderValue: '',
    headers: [],
    idempotency: false,
  };
}

export function blankDelivery(): Delivery {
  return {
    batchSize: 1,
    maxAttempts: 3,
    minDelayMs: 0,
    timeoutMs: 15000,
    onError: 'continue',
    onSchemaChange: 'stop',
  };
}

export interface ScheduleDraft {
  cron: string;
  timezone: string;
  enabled: boolean;
}

export type SyncMode = 'oneTime' | 'live';
export type TriggerKind = 'replay' | 'watch' | 'cdc';
export type WatchStrategy = 'increment' | 'timestamp' | 'snapshot';
export type CdcOp = 'insert' | 'update' | 'delete' | 'truncate';

/** the comparisons the filter editor offers (`in` belongs to the row selection) */
export type FilterOperator = Exclude<FilterSpec['operator'], 'in'>;
export const FILTER_OPERATORS: FilterOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'endsWith',
  'isNull',
  'notNull',
];
/** operators that compare against nothing */
export const VALUELESS: ReadonlySet<FilterOperator> = new Set(['isNull', 'notNull']);

export interface DraftFilter {
  /** stable across edits, for React */
  id: string;
  column: string;
  operator: FilterOperator;
  /** as typed; turned into a number or a boolean on save where the column is one */
  value: string;
}

export type DraftTransform = ColumnTransform & { id: string };

let nextId = 0;
export const draftId = (): string => `d${++nextId}`;
export type RowMode = 'selected' | 'all';

export interface BuilderDraft {
  // ----- source -----
  name: string;
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  mode: RowMode;
  selectedKeys: Map<string, unknown>;
  included: Set<string>;
  /** column preference: null = all columns, array = a pinned subset (editing) */
  fieldsPref: string[] | null;
  offset: number;
  // ----- trigger -----
  // the builder is locked to one of two modes, decided by the toggle (new)
  // or the bridge's existing trigger (editing). 'oneTime' = a replay-only
  // job, 'live' = listen-only (polling/CDC). they never share trigger UI
  syncMode: SyncMode;
  triggerKind: TriggerKind;
  watchStrategy: WatchStrategy;
  watchColumn: string;
  pollSeconds: number;
  watchStartFrom: 'now' | 'beginning';
  /**
   * a change-stream bridge: follow changes from now on, or copy what the table
   * already holds first and then follow it (nothing is lost in between)
   */
  cdcStartFrom: 'now' | 'beginning';
  /**
   * PostgreSQL only: a replication slot of the bridge's own, or the one every
   * shared bridge on the same connection and database reads through
   */
  cdcSlot: 'own' | 'shared';
  /**
   * a one-time bridge that runs by itself: a cron line, the zone it is meant
   * in, and whether it is on. null = only when somebody presses Run
   */
  schedule: ScheduleDraft | null;
  /**
   * parts of a watch trigger the builder has no control for. they are carried
   * through an edit untouched: saving used to write the constants 500 / 50,000
   * / 3,000 every time, so opening a bridge and pressing Save quietly undid
   * whatever had been set through the API
   */
  maxPerPoll: number;
  snapshotMaxTracked: number;
  lookbackMs: number;
  cdcOps: Set<CdcOp>;
  readiness: CdcReadiness | null;
  checkingCdc: boolean;
  // ----- which rows, and what happens to their values -----
  /** "only rows where…", ANDed together (and with the row selection, if any) */
  filters: DraftFilter[];
  /**
   * filters this editor has no row for (an `in` list, say) — set through the
   * API. carried through an edit exactly as they are: the builder used to read
   * one filter back and write one filter out, so saving a bridge from here
   * silently deleted every other condition on it
   */
  extraFilters: FilterSpec[];
  /** masking, casts, computed columns — applied in this order */
  transforms: DraftTransform[];
  // ----- payload / destination / delivery -----
  /** the HTTP payload template and key renames; no control here, carried through an edit */
  template: string;
  rename: Record<string, string> | undefined;
  wrapKey: string;
  destKind: 'http' | 'database';
  dest: Destination;
  dbTargets: DbTarget[];
  delivery: Delivery;
  /** preserved on edit so saving doesn't silently re-enable a disabled bridge */
  enabled: boolean;
}

/**
 * what a NEW bridge starts from: the instance's saved defaults (Settings ›
 * Bridges). they were stored and shown for a year while the builder went on
 * using 5 seconds, 500 rows and all three operations regardless
 */
export interface BuilderDefaults {
  pollIntervalMs: number;
  maxPerPoll: number;
  cdcOperations: CdcOp[];
}

export const BUILT_IN_DEFAULTS: BuilderDefaults = {
  pollIntervalMs: 5000,
  maxPerPoll: 500,
  cdcOperations: ['insert', 'update', 'delete'],
};

export function initialDraft(
  defaults: BuilderDefaults = BUILT_IN_DEFAULTS,
): BuilderDraft {
  return {
    name: '',
    connectionId: '',
    database: '',
    schema: '',
    table: '',
    mode: 'all',
    selectedKeys: new Map(),
    included: new Set(),
    fieldsPref: null,
    offset: 0,
    syncMode: 'oneTime',
    triggerKind: 'replay',
    watchStrategy: 'increment',
    watchColumn: '',
    pollSeconds: Math.max(1, Math.round(defaults.pollIntervalMs / 1000)),
    watchStartFrom: 'now',
    cdcStartFrom: 'now',
    cdcSlot: 'own',
    schedule: null,
    maxPerPoll: defaults.maxPerPoll,
    snapshotMaxTracked: 50_000,
    lookbackMs: 3000,
    cdcOps: new Set(
      defaults.cdcOperations.length > 0
        ? defaults.cdcOperations
        : BUILT_IN_DEFAULTS.cdcOperations,
    ),
    readiness: null,
    checkingCdc: false,
    filters: [],
    extraFilters: [],
    transforms: [],
    template: '{{$row}}',
    rename: undefined,
    wrapKey: '',
    destKind: 'http',
    dest: blankDestination(),
    dbTargets: [blankDbTarget()],
    delivery: blankDelivery(),
    enabled: true,
  };
}

export type BuilderAction =
  /** back to a blank draft (opening the editor, or before an edit load) */
  | { type: 'reset'; defaults?: BuilderDefaults }
  /** replace the draft with a fully hydrated one (edit-mode load) */
  | { type: 'load'; draft: BuilderDraft }
  /** prefill source fields when opened from the schema tree */
  | {
      type: 'applySeed';
      connectionId: string;
      database: string;
      schema: string;
      table: string;
      name: string;
    }
  | { type: 'setName'; name: string }
  | { type: 'selectConnection'; connectionId: string }
  | { type: 'selectDatabase'; database: string }
  | { type: 'selectTable'; table: string }
  | { type: 'setMode'; mode: RowMode }
  | { type: 'toggleRow'; key: string; value: unknown }
  | { type: 'togglePage'; entries: { key: string; value: unknown }[] }
  | { type: 'toggleColumn'; name: string }
  | { type: 'setIncluded'; included: Set<string> }
  | { type: 'setOffset'; offset: number }
  | { type: 'setSyncMode'; syncMode: SyncMode }
  | { type: 'setTriggerKind'; triggerKind: TriggerKind }
  | { type: 'setWatchStrategy'; strategy: WatchStrategy }
  | { type: 'setWatchColumn'; column: string }
  | { type: 'setPollSeconds'; seconds: number }
  | { type: 'setWatchStartFrom'; startFrom: 'now' | 'beginning' }
  | { type: 'setCdcStartFrom'; startFrom: 'now' | 'beginning' }
  | { type: 'setCdcSlot'; slot: 'own' | 'shared' }
  | { type: 'toggleCdcOp'; op: CdcOp }
  | { type: 'setReadiness'; readiness: CdcReadiness | null }
  | { type: 'setCheckingCdc'; checking: boolean }
  | { type: 'addFilter'; column: string }
  | { type: 'patchFilter'; id: string; patch: Partial<Omit<DraftFilter, 'id'>> }
  | { type: 'removeFilter'; id: string }
  | { type: 'addTransform'; transform: ColumnTransform }
  | { type: 'replaceTransform'; id: string; transform: ColumnTransform }
  | { type: 'moveTransform'; id: string; by: -1 | 1 }
  | { type: 'removeTransform'; id: string }
  | { type: 'setWrapKey'; wrapKey: string }
  | { type: 'setDestKind'; destKind: 'http' | 'database'; sourcePk: string | null }
  | { type: 'patchDest'; patch: Partial<Destination> }
  | { type: 'addDestHeader' }
  | { type: 'patchDestHeader'; index: number; patch: Partial<{ key: string; value: string }> }
  | { type: 'removeDestHeader'; index: number }
  | { type: 'patchDbTarget'; index: number; patch: Partial<DbTarget> }
  | { type: 'addDbTarget'; sourcePk: string | null }
  | { type: 'removeDbTarget'; index: number }
  | { type: 'patchDelivery'; patch: Partial<Delivery> }
  | { type: 'setSchedule'; schedule: ScheduleDraft | null }
  | { type: 'patchSchedule'; patch: Partial<ScheduleDraft> };

/**
 * conditions and steps name columns of ONE table. leaving it — for another
 * table, database or connection — leaves them behind
 */
const noRowRules = (): Pick<BuilderDraft, 'filters' | 'extraFilters' | 'transforms'> => ({
  filters: [],
  extraFilters: [],
  transforms: [],
});

export function builderReducer(d: BuilderDraft, action: BuilderAction): BuilderDraft {
  switch (action.type) {
    case 'reset':
      // an in-flight readiness probe keeps its spinner; its own finally clears it
      return { ...initialDraft(action.defaults), checkingCdc: d.checkingCdc };
    case 'load':
      return { ...action.draft, checkingCdc: d.checkingCdc };
    case 'applySeed':
      return {
        ...d,
        connectionId: action.connectionId,
        database: action.database,
        schema: action.schema,
        table: action.table,
        name: action.name,
      };
    case 'setName':
      return { ...d, name: action.name };
    case 'selectConnection':
      // a new connection invalidates everything picked under the old one
      return {
        ...d,
        connectionId: action.connectionId,
        table: '',
        database: '',
        included: new Set(),
        fieldsPref: null,
        selectedKeys: new Map(),
        ...noRowRules(),
      };
    case 'selectDatabase':
      return {
        ...d,
        database: action.database,
        table: '',
        included: new Set(),
        fieldsPref: null,
        ...noRowRules(),
      };
    case 'selectTable':
      return {
        ...d,
        table: action.table,
        offset: 0,
        included: new Set(),
        fieldsPref: null,
        selectedKeys: new Map(),
        readiness: null,
        ...noRowRules(),
      };
    case 'setMode':
      return { ...d, mode: action.mode };
    case 'toggleRow': {
      const next = new Map(d.selectedKeys);
      if (next.has(action.key)) next.delete(action.key);
      else next.set(action.key, action.value);
      return { ...d, selectedKeys: next };
    }
    case 'togglePage': {
      const next = new Map(d.selectedKeys);
      const allOn = action.entries.every((e) => next.has(e.key));
      for (const e of action.entries) {
        if (allOn) next.delete(e.key);
        else next.set(e.key, e.value);
      }
      return { ...d, selectedKeys: next };
    }
    case 'toggleColumn': {
      const next = new Set(d.included);
      if (next.has(action.name)) next.delete(action.name);
      else next.add(action.name);
      return { ...d, included: next };
    }
    case 'setIncluded':
      return { ...d, included: action.included };
    case 'setOffset':
      return { ...d, offset: action.offset };
    case 'setSyncMode':
      // the two modes never share trigger UI, so the kind follows the mode
      return {
        ...d,
        syncMode: action.syncMode,
        triggerKind: action.syncMode === 'live' ? 'watch' : 'replay',
      };
    case 'setTriggerKind':
      return { ...d, triggerKind: action.triggerKind };
    case 'setWatchStrategy':
      return { ...d, watchStrategy: action.strategy };
    case 'setWatchColumn':
      return { ...d, watchColumn: action.column };
    case 'setPollSeconds':
      return { ...d, pollSeconds: action.seconds };
    case 'setWatchStartFrom':
      return { ...d, watchStartFrom: action.startFrom };
    case 'setCdcStartFrom':
      return { ...d, cdcStartFrom: action.startFrom };
    case 'setCdcSlot':
      // what the server was asked about is no longer what will be set up
      return { ...d, cdcSlot: action.slot, readiness: null };
    case 'setSchedule':
      return { ...d, schedule: action.schedule };
    case 'patchSchedule':
      return d.schedule ? { ...d, schedule: { ...d.schedule, ...action.patch } } : d;
    case 'toggleCdcOp': {
      const next = new Set(d.cdcOps);
      if (next.has(action.op)) next.delete(action.op);
      else next.add(action.op);
      return { ...d, cdcOps: next };
    }
    case 'setReadiness':
      return { ...d, readiness: action.readiness };
    case 'setCheckingCdc':
      return { ...d, checkingCdc: action.checking };
    case 'addFilter':
      return {
        ...d,
        filters: [...d.filters, { id: draftId(), column: action.column, operator: 'eq', value: '' }],
      };
    case 'patchFilter':
      return {
        ...d,
        filters: d.filters.map((f) => (f.id === action.id ? { ...f, ...action.patch } : f)),
      };
    case 'removeFilter':
      return { ...d, filters: d.filters.filter((f) => f.id !== action.id) };
    case 'addTransform':
      return { ...d, transforms: [...d.transforms, { ...action.transform, id: draftId() }] };
    case 'replaceTransform':
      return {
        ...d,
        transforms: d.transforms.map((t) => (t.id === action.id ? { ...action.transform, id: t.id } : t)),
      };
    case 'moveTransform': {
      const from = d.transforms.findIndex((t) => t.id === action.id);
      const to = from + action.by;
      if (from < 0 || to < 0 || to >= d.transforms.length) return d;
      const next = [...d.transforms];
      [next[from], next[to]] = [next[to]!, next[from]!];
      return { ...d, transforms: next };
    }
    case 'removeTransform':
      return { ...d, transforms: d.transforms.filter((t) => t.id !== action.id) };
    case 'setWrapKey':
      return { ...d, wrapKey: action.wrapKey };
    case 'setDestKind': {
      // seed the first target's key with the source PK so an upsert works out
      // of the box
      const dbTargets =
        action.destKind === 'database' && action.sourcePk
          ? d.dbTargets.map((t, i) =>
              i === 0 && t.keyColumns.length === 0
                ? { ...t, keyColumns: [action.sourcePk as string] }
                : t,
            )
          : d.dbTargets;
      return {
        ...d,
        destKind: action.destKind,
        dbTargets,
        // `evolve` alters a destination TABLE: there is none behind a webhook
        delivery:
          action.destKind === 'http' && d.delivery.onSchemaChange === 'evolve'
            ? { ...d.delivery, onSchemaChange: 'stop' }
            : d.delivery,
      };
    }
    case 'patchDest':
      return { ...d, dest: { ...d.dest, ...action.patch } };
    case 'addDestHeader':
      return {
        ...d,
        dest: { ...d.dest, headers: [...d.dest.headers, { key: '', value: '' }] },
      };
    case 'patchDestHeader':
      return {
        ...d,
        dest: {
          ...d.dest,
          headers: d.dest.headers.map((x, j) =>
            j === action.index ? { ...x, ...action.patch } : x,
          ),
        },
      };
    case 'removeDestHeader':
      return {
        ...d,
        dest: {
          ...d.dest,
          headers: d.dest.headers.filter((_, j) => j !== action.index),
        },
      };
    case 'patchDbTarget':
      return {
        ...d,
        dbTargets: d.dbTargets.map((t, j) =>
          j === action.index ? { ...t, ...action.patch } : t,
        ),
      };
    case 'addDbTarget':
      return {
        ...d,
        dbTargets: [
          ...d.dbTargets,
          { ...blankDbTarget(), keyColumns: action.sourcePk ? [action.sourcePk] : [] },
        ],
      };
    case 'removeDbTarget':
      return {
        ...d,
        dbTargets: d.dbTargets.filter((_, j) => j !== action.index),
      };
    case 'patchDelivery':
      return { ...d, delivery: { ...d.delivery, ...action.patch } };
  }
}
