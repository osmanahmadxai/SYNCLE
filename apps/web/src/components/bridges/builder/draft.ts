/**
 * the bridge builder's draft state: one typed object + a reducer, replacing the
 * pile of useState calls the builder used to juggle. every cross-field cascade
 * (changing the connection resets the table, changing the table resets the
 * column/row selections, toggling the sync mode adjusts the trigger, …) lives
 * here so a section can never forget one.
 */
import type { CdcReadiness } from '@syncle/core';

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
}

export interface Delivery {
  batchSize: number;
  maxAttempts: number;
  minDelayMs: number;
  timeoutMs: number;
  onError: 'continue' | 'abort';
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
  };
}

export type SyncMode = 'oneTime' | 'live';
export type TriggerKind = 'replay' | 'watch' | 'cdc';
export type WatchStrategy = 'increment' | 'timestamp' | 'snapshot';
export type CdcOp = 'insert' | 'update' | 'delete';
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
  cdcOps: Set<CdcOp>;
  readiness: CdcReadiness | null;
  checkingCdc: boolean;
  // ----- payload / destination / delivery -----
  wrapKey: string;
  destKind: 'http' | 'database';
  dest: Destination;
  dbTargets: DbTarget[];
  delivery: Delivery;
  /** preserved on edit so saving doesn't silently re-enable a disabled bridge */
  enabled: boolean;
}

export function initialDraft(): BuilderDraft {
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
    pollSeconds: 5,
    watchStartFrom: 'now',
    cdcOps: new Set(['insert', 'update', 'delete']),
    readiness: null,
    checkingCdc: false,
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
  | { type: 'reset' }
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
  | { type: 'toggleCdcOp'; op: CdcOp }
  | { type: 'setReadiness'; readiness: CdcReadiness | null }
  | { type: 'setCheckingCdc'; checking: boolean }
  | { type: 'setWrapKey'; wrapKey: string }
  | { type: 'setDestKind'; destKind: 'http' | 'database'; sourcePk: string | null }
  | { type: 'patchDest'; patch: Partial<Destination> }
  | { type: 'addDestHeader' }
  | { type: 'patchDestHeader'; index: number; patch: Partial<{ key: string; value: string }> }
  | { type: 'removeDestHeader'; index: number }
  | { type: 'patchDbTarget'; index: number; patch: Partial<DbTarget> }
  | { type: 'addDbTarget'; sourcePk: string | null }
  | { type: 'removeDbTarget'; index: number }
  | { type: 'patchDelivery'; patch: Partial<Delivery> };

export function builderReducer(d: BuilderDraft, action: BuilderAction): BuilderDraft {
  switch (action.type) {
    case 'reset':
      // an in-flight readiness probe keeps its spinner; its own finally clears it
      return { ...initialDraft(), checkingCdc: d.checkingCdc };
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
      };
    case 'selectDatabase':
      return {
        ...d,
        database: action.database,
        table: '',
        included: new Set(),
        fieldsPref: null,
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
      return { ...d, destKind: action.destKind, dbTargets };
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
