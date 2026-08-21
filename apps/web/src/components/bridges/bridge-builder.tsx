'use client';

/**
 * full-screen bridge editor. this file is the orchestrator: it owns the draft
 * reducer, the source queries, and the save flow, and composes the section
 * components in `./builder/`. the draft state + cascades live in
 * `./builder/draft.ts`, the pure load/save mappings in `./builder/mapping.ts`.
 */
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { Loader2, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { TableSchema } from '@syncle/core';
import { api, ApiError } from '@/lib/api';
import {
  useBrowse,
  useConnections,
  useCreateBridge,
  useDatabases,
  useSchema,
  useUpdateBridge,
} from '@/lib/queries';
import { useStudio } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { PAGE_SIZE, builderReducer, initialDraft } from './builder/draft';
import { buildInput, loadBridge } from './builder/mapping';
import { SourceSection } from './builder/source-section';
import { TriggerSection } from './builder/trigger-section';
import { PayloadSection } from './builder/payload-section';
import { DestinationSection } from './builder/destination-section';
import { DeliverySection } from './builder/delivery-section';

export function BridgeBuilder() {
  const t = useTranslations('bridgeBuilder');
  const { bridgeEditor, closeBridgeEditor, selectBridge, openConnectionDialog } =
    useStudio();
  const editing = bridgeEditor.editingId;
  const create = useCreateBridge();
  const update = useUpdateBridge();

  const [draft, dispatch] = useReducer(builderReducer, undefined, initialDraft);
  const { connectionId, database, schema, table, mode, selectedKeys, included } =
    draft;

  const { data: connections } = useConnections();
  const { data: databases } = useDatabases(connectionId || null);
  const { data: schemaData } = useSchema(
    connectionId || null,
    database || undefined,
  );
  const tables = useMemo<TableSchema[]>(
    () => schemaData?.namespaces.flatMap((ns) => ns.tables) ?? [],
    [schemaData],
  );

  const browseParams = useMemo(
    () =>
      table
        ? { schema: schema || undefined, table, limit: PAGE_SIZE, offset: draft.offset }
        : null,
    [table, schema, draft.offset],
  );
  const {
    data: browse,
    isFetching,
    refetch,
  } = useBrowse(connectionId || null, browseParams, database || undefined);

  const columns = useMemo(() => browse?.columns ?? [], [browse]);
  const rows = useMemo(() => browse?.rows ?? [], [browse]);
  const pk = useMemo(() => browse?.primaryKey ?? [], [browse]);
  const singlePk = pk.length === 1 ? pk[0]! : null;

  /* populate from an existing bridge or a seed when opened */
  useEffect(() => {
    if (!bridgeEditor.open) return;
    if (editing) {
      // start clean, and ignore the response if the editor moved on to a
      // different bridge (or closed) before this load resolved
      dispatch({ type: 'reset' });
      let stale = false;
      api.getBridge(editing).then(
        (h) => {
          if (!stale) dispatch({ type: 'load', draft: loadBridge(h) });
        },
        (err) => {
          if (stale) return;
          toast.error(t('loadFailed'), {
            description: err instanceof ApiError ? err.message : String(err),
          });
        },
      );
      return () => {
        stale = true;
      };
    }
    // a new bridge runs an on-demand job by default (the reset draft); the user
    // can switch it to a live bridge in the "What runs in this bridge" selector
    dispatch({ type: 'reset' });
    if (bridgeEditor.seed) {
      dispatch({
        type: 'applySeed',
        connectionId: bridgeEditor.seed.connectionId,
        database: bridgeEditor.seed.database ?? '',
        schema: bridgeEditor.seed.schema ?? '',
        table: bridgeEditor.seed.table,
        name: t('defaultName', { table: bridgeEditor.seed.table }),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeEditor.open, editing, bridgeEditor.seed]);

  /*
   * whenever a (new) table's columns load, include ALL of them by default.
   * keyed on the column signature so switching between tables (even ones with
   * the same column count) re-initializes. when editing a bridge that pinned a
   * subset, the draft's `fieldsPref` is applied once instead.
   */
  const colSig = columns.map((c) => c.name).join(' ');
  const appliedKey = useRef('');
  useEffect(() => {
    if (columns.length === 0) return;
    const key = `${colSig}|${draft.fieldsPref ? draft.fieldsPref.join(' ') : '*'}`;
    if (appliedKey.current === key) return;
    appliedKey.current = key;
    const all = columns.map((c) => c.name);
    if (draft.fieldsPref && draft.fieldsPref.length > 0) {
      const allow = new Set(draft.fieldsPref);
      dispatch({
        type: 'setIncluded',
        included: new Set(all.filter((n) => allow.has(n))),
      });
    } else {
      dispatch({ type: 'setIncluded', included: new Set(all) });
    }
  }, [colSig, draft.fieldsPref, columns]);

  /* row used to preview the payload: a selected one if available, else first */
  const sampleRow = useMemo(() => {
    if (mode === 'selected' && singlePk) {
      const hit = rows.find((r) => selectedKeys.has(String(r[singlePk])));
      if (hit) return hit;
    }
    return rows[0];
  }, [rows, mode, singlePk, selectedKeys]);

  const includedList = useMemo(
    () => columns.map((c) => c.name).filter((n) => included.has(n)),
    [columns, included],
  );

  /* ----- save ----- */

  const sendCount =
    mode === 'selected' ? selectedKeys.size : (browse?.total ?? null);
  const watchNeedsColumn =
    draft.triggerKind === 'watch' &&
    draft.watchStrategy !== 'snapshot' &&
    !draft.watchColumn;
  const destReady =
    draft.destKind === 'http'
      ? draft.dest.url.trim().length > 0
      : draft.dbTargets.length > 0 &&
        draft.dbTargets.every(
          (t) =>
            !!t.connectionId &&
            t.table.trim().length > 0 &&
            (t.writeMode === 'insert' || t.keyColumns.length > 0),
        );
  const canSave =
    !!connectionId &&
    !!table &&
    destReady &&
    includedList.length > 0 &&
    !(mode === 'selected' && (!singlePk || selectedKeys.size === 0)) &&
    !watchNeedsColumn;

  async function handleSave() {
    try {
      const input = buildInput(draft, {
        columns: columns.map((c) => c.name),
        singlePk,
        fallbackName: t('defaultName', { table }),
      });
      if (editing) {
        await update.mutateAsync({ id: editing, input });
        toast.success(t('bridgeUpdated'));
      } else {
        const bridge = await create.mutateAsync(input);
        selectBridge(bridge.id);
        toast.success(t('bridgeCreated'));
      }
      closeBridgeEditor();
    } catch (err) {
      toast.error(t('saveFailed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  if (!bridgeEditor.open) return null;
  const saving = create.isPending || update.isPending;

  return (
    <div className="bg-background fixed inset-0 z-40 flex flex-col">
      {/* top bar */}
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <Webhook className="text-primary h-5 w-5" />
        <Input
          value={draft.name}
          onChange={(e) => dispatch({ type: 'setName', name: e.target.value })}
          placeholder={t('namePlaceholder')}
          className="h-8 max-w-xs font-medium"
        />
        <div className="text-muted-foreground ml-2 text-sm">
          {draft.syncMode === 'oneTime'
            ? sendCount != null && (
                <span>
                  {mode === 'selected'
                    ? t('sendsSelected', {
                        count: sendCount,
                        cols: includedList.length,
                        total: columns.length,
                      })
                    : t('sendsAll', {
                        count: sendCount,
                        cols: includedList.length,
                        total: columns.length,
                      })}
                </span>
              )
            : table && (
                <span>
                  {t('streamsNewRows', {
                    cols: includedList.length,
                    total: columns.length,
                  })}
                </span>
              )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={closeBridgeEditor}>
            {t('cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? t('saveBridge') : t('createBridge')}
          </Button>
        </div>
      </div>

      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* ---- source / grid ---- */}
        <ResizablePanel defaultSize={64} minSize={40}>
          <SourceSection
            draft={draft}
            dispatch={dispatch}
            connections={connections}
            databases={databases}
            tables={tables}
            columns={columns}
            rows={rows}
            pk={pk}
            singlePk={singlePk}
            browse={browse}
            isFetching={isFetching}
            onRefetch={refetch}
            openConnectionDialog={openConnectionDialog}
          />
        </ResizablePanel>

        <ResizableHandle />

        {/* ---- config ---- */}
        <ResizablePanel defaultSize={36} minSize={26}>
          <div className="h-full overflow-y-auto">
            <div className="space-y-5 p-4">
              <TriggerSection draft={draft} dispatch={dispatch} columns={columns} />
              <PayloadSection
                draft={draft}
                dispatch={dispatch}
                sampleRow={sampleRow}
                includedList={includedList}
              />
              <DestinationSection
                draft={draft}
                dispatch={dispatch}
                includedList={includedList}
                singlePk={singlePk}
              />
              <DeliverySection draft={draft} dispatch={dispatch} />
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
