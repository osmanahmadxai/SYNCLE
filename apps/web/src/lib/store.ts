'use client';

import { create } from 'zustand';
import type { RelationKind } from '@syncle/core';

export type StudioTab = 'data' | 'query' | 'structure' | 'diagram';

export interface SelectedRelation {
  schema?: string;
  table: string;
  kind: RelationKind;
}

/** prefill payload when opening the bridge editor (e.g. from the schema tree) */
export interface BridgeEditorSeed {
  connectionId: string;
  database?: string;
  schema?: string;
  table: string;
}

export interface QueryTab {
  id: string;
  name: string;
  sql: string;
}

let tabSeq = 0;
const nextTabId = () => `qt_${++tabSeq}`;

function freshTabs(): { tabs: QueryTab[]; activeId: string } {
  const id = nextTabId();
  return { tabs: [{ id, name: 'Query 1', sql: '' }], activeId: id };
}

interface StudioState {
  /** the workspace currently in view; everything is scoped to it */
  activeWorkspaceId: string | null;

  activeConnectionId: string | null;
  activeDatabase?: string;
  selected: SelectedRelation | null;
  tab: StudioTab;

  /** connection editor dialog state */
  dialog: { open: boolean; editingId: string | null };

  /** the bridge currently open in the main panel */
  selectedBridgeId: string | null;
  /** bridge editor dialog: open + which bridge (null = new) + optional prefill */
  bridgeEditor: {
    open: boolean;
    editingId: string | null;
    seed: BridgeEditorSeed | null;
  };
  /** the full DB/table management surface (connections, schema, browse, DDL) */
  dataSourcesOpen: boolean;

  /** query editor tabs, lifted here so they survive view switches */
  queryTabs: QueryTab[];
  activeQueryTabId: string;

  setActiveWorkspace: (id: string | null) => void;
  setActiveConnection: (id: string | null) => void;
  setActiveDatabase: (db?: string) => void;
  selectRelation: (rel: SelectedRelation) => void;
  /** e.g. after the selected table was dropped */
  clearSelection: () => void;
  setTab: (tab: StudioTab) => void;

  selectBridge: (id: string | null) => void;
  openBridgeEditor: (opts?: {
    editingId?: string | null;
    seed?: BridgeEditorSeed;
  }) => void;
  closeBridgeEditor: () => void;
  openDataSources: () => void;
  closeDataSources: () => void;

  addQueryTab: (opts?: { sql?: string; name?: string }) => void;
  closeQueryTab: (id: string) => void;
  setActiveQueryTab: (id: string) => void;
  updateQueryTabSql: (id: string, sql: string) => void;
  /** open a statement in a NEW query tab and switch to the Query view */
  openInQuery: (statement: string, name?: string) => void;

  openConnectionDialog: (editingId?: string | null) => void;
  closeConnectionDialog: () => void;
}

const initial = freshTabs();

/** localStorage key for the last active workspace (survives refreshes) */
const WORKSPACE_STORAGE_KEY = 'syncle.activeWorkspaceId';

export function readPersistedWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
}

function persistWorkspaceId(id: string | null) {
  if (typeof window === 'undefined') return;
  if (id) window.localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
  else window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
}

export const useStudio = create<StudioState>((set) => ({
  activeWorkspaceId: readPersistedWorkspaceId(),
  activeConnectionId: null,
  activeDatabase: undefined,
  selected: null,
  tab: 'data',
  dialog: { open: false, editingId: null },
  selectedBridgeId: null,
  bridgeEditor: { open: false, editingId: null, seed: null },
  dataSourcesOpen: false,
  queryTabs: initial.tabs,
  activeQueryTabId: initial.activeId,

  // selecting a bridge and browsing a table are mutually exclusive. the main
  // view shows the table preview when one is picked, else the workspace map
  selectBridge: (id) => set({ selectedBridgeId: id, selected: null }),
  openBridgeEditor: (opts) =>
    set({
      bridgeEditor: {
        open: true,
        editingId: opts?.editingId ?? null,
        seed: opts?.seed ?? null,
      },
    }),
  closeBridgeEditor: () =>
    set({ bridgeEditor: { open: false, editingId: null, seed: null } }),
  openDataSources: () => set({ dataSourcesOpen: true }),
  closeDataSources: () => set({ dataSourcesOpen: false }),

  // actually switching workspace drops the selected bridge, table and
  // connection (they live in another one); re-setting the same id is a no-op
  // so a URL/localStorage restore isn't wiped
  setActiveWorkspace: (id) =>
    set((s) => {
      persistWorkspaceId(id);
      if (s.activeWorkspaceId === id) return {};
      return {
        activeWorkspaceId: id,
        selectedBridgeId: null,
        selected: null,
        activeConnectionId: null,
        activeDatabase: undefined,
      };
    }),

  setActiveConnection: (id) => {
    const f = freshTabs();
    set({
      activeConnectionId: id,
      activeDatabase: undefined,
      selected: null,
      tab: 'data',
      queryTabs: f.tabs,
      activeQueryTabId: f.activeId,
    });
  },
  setActiveDatabase: (db) => set({ activeDatabase: db, selected: null }),
  selectRelation: (rel) =>
    set({ selected: rel, tab: 'data', selectedBridgeId: null }),
  clearSelection: () => set({ selected: null }),
  setTab: (tab) => set({ tab }),

  addQueryTab: (opts) =>
    set((s) => {
      const id = nextTabId();
      const name = opts?.name ?? `Query ${s.queryTabs.length + 1}`;
      return {
        queryTabs: [...s.queryTabs, { id, name, sql: opts?.sql ?? '' }],
        activeQueryTabId: id,
      };
    }),
  closeQueryTab: (id) =>
    set((s) => {
      if (s.queryTabs.length === 1) {
        const f = freshTabs();
        return { queryTabs: f.tabs, activeQueryTabId: f.activeId };
      }
      const idx = s.queryTabs.findIndex((t) => t.id === id);
      const tabs = s.queryTabs.filter((t) => t.id !== id);
      const activeQueryTabId =
        s.activeQueryTabId === id
          ? (tabs[Math.max(0, idx - 1)]?.id ?? tabs[0]!.id)
          : s.activeQueryTabId;
      return { queryTabs: tabs, activeQueryTabId };
    }),
  setActiveQueryTab: (id) => set({ activeQueryTabId: id }),
  updateQueryTabSql: (id, sql) =>
    set((s) => ({
      queryTabs: s.queryTabs.map((t) => (t.id === id ? { ...t, sql } : t)),
    })),
  openInQuery: (statement, name) =>
    set((s) => {
      const id = nextTabId();
      return {
        queryTabs: [
          ...s.queryTabs,
          {
            id,
            name: name ?? `Query ${s.queryTabs.length + 1}`,
            sql: statement,
          },
        ],
        activeQueryTabId: id,
        tab: 'query',
      };
    }),

  openConnectionDialog: (editingId = null) =>
    set({ dialog: { open: true, editingId } }),
  closeConnectionDialog: () =>
    set({ dialog: { open: false, editingId: null } }),
}));
