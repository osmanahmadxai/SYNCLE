'use client';

/**
 * full-screen bridge editor. this file is the orchestrator: it owns the draft
 * reducer, the source queries, and the save flow, and composes the section
 * components in `./builder/`. the draft state + cascades live in
 * `./builder/draft.ts`, the pure load/save mappings in `./builder/mapping.ts`.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { FlaskConical, Loader2, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  columnsAdded,
  type BridgePreview,
  type TableSchema,
} from '@syncle/core';
import { api, ApiError } from '@/lib/api';
import {
  useBrowse,
  useConnections,
  useSettings,
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
import { buildInput, draftTransforms, loadBridge } from './builder/mapping';
import { SourceSection } from './builder/source-section';
import { TriggerSection } from './builder/trigger-section';
import { DryRunDialog } from './builder/dry-run-dialog';
import { FiltersSection } from './builder/filters-section';
import { TransformsSection } from './builder/transforms-section';
import { incompleteFilter, incompleteTransform } from './builder/transform-options';
import { PayloadSection } from './builder/payload-section';
import { DestinationSection } from './builder/destination-section';
import { DeliverySection } from './builder/delivery-section';
import { ScheduleSection } from './builder/schedule-section';
import { scheduleProblem } from './builder/schedule-options';

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
  const { data: settings } = useSettings();
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
    // can switch it to a live bridge in the "What runs in this bridge" selector.
    // it starts from the instance's saved defaults (Settings › Bridges)
    dispatch({
      type: 'reset',
      defaults: settings
        ? {
            pollIntervalMs: settings.defaultPollIntervalMs,
            maxPerPoll: settings.defaultMaxPerPoll,
            cdcOperations: settings.defaultCdcOperations,
          }
        : undefined,
    });
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

  const columnNames = useMemo(() => columns.map((c) => c.name), [columns]);

  /* what each column holds, as far as a sample row can tell: a filter typed as
     "42" on a numeric column is sent as the number 42 */
  const columnTypes = useMemo(() => {
    const types: Record<string, string> = {};
    for (const name of columnNames) {
      const seen = rows.find((r) => r[name] !== null && r[name] !== undefined);
      if (seen) types[name] = typeof seen[name];
    }
    return types;
  }, [columnNames, rows]);

  /* the steps exactly as they will be saved, so the preview shows what will run */
  const { transforms: draftSteps } = draft;
  const transformList = useMemo(
    () => draftTransforms({ transforms: draftSteps }, columnTypes),
    [draftSteps, columnTypes],
  );

  /* what is sent: the ticked columns, then the ones the transforms add */
  const includedList = useMemo(
    () => [
      ...columnNames.filter((n) => included.has(n)),
      ...columnsAdded(transformList, columnNames),
    ],
    [columnNames, included, transformList],
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
            (t.writeMode === 'insert' || t.keyColumns.length > 0) &&
            // a soft delete marks the row in a column of its own
            (t.onDelete !== 'soft' ||
              (t.softDeleteColumn.trim().length > 0 &&
                !t.keyColumns.includes(t.softDeleteColumn.trim()))),
        );
  const canSave =
    !!connectionId &&
    !!table &&
    destReady &&
    includedList.length > 0 &&
    !(mode === 'selected' && (!singlePk || selectedKeys.size === 0)) &&
    !watchNeedsColumn &&
    // a half-written condition or step is never dropped on save: it blocks it
    !draft.filters.some(incompleteFilter) &&
    !draft.transforms.some(incompleteTransform) &&
    // a schedule that would be refused is not sent to be refused
    !(draft.syncMode === 'oneTime' && scheduleProblem(draft.schedule));

  const [dryRun, setDryRun] = useState<{
    open: boolean;
    loading: boolean;
    preview: BridgePreview | null;
    error: string | null;
  }>({ open: false, loading: false, preview: null, error: null });

  async function handleSave() {
    try {
      const input = buildInput(draft, {
        columns: columnNames,
        singlePk,
        fallbackName: t('defaultName', { table }),
        columnTypes,
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

  /** what this draft would do, without saving it or writing anything */
  async function handleDryRun() {
    setDryRun({ open: true, loading: true, preview: null, error: null });
    try {
      const input = buildInput(draft, {
        columns: columnNames,
        singlePk,
        fallbackName: t('defaultName', { table }),
        columnTypes,
      });
      const preview = await api.previewDraft(input);
      setDryRun({ open: true, loading: false, preview, error: null });
    } catch (err) {
      setDryRun({
        open: true,
        loading: false,
        preview: null,
        error: err instanceof ApiError ? err.message : String(err),
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
          <Button
            variant="outline"
            onClick={handleDryRun}
            disabled={!canSave || dryRun.loading}
            title={t('dryRunHint')}
          >
            {dryRun.loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FlaskConical className="mr-2 h-4 w-4" />
            )}
            {t('dryRun')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? t('saveBridge') : t('createBridge')}
          </Button>
        </div>
      </div>

      <DryRunDialog
        open={dryRun.open}
        onOpenChange={(open) => setDryRun((d) => ({ ...d, open }))}
        loading={dryRun.loading}
        preview={dryRun.preview}
        error={dryRun.error}
      />

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
              <TriggerSection
                draft={draft}
                dispatch={dispatch}
                columns={columns}
                sourceEngine={
                  connections?.find((c) => c.id === connectionId)?.engine
                }
                bridgeId={editing}
              />
              {/* a one-time bridge can run by itself, on a cron line */}
              {draft.syncMode === 'oneTime' && (
                <ScheduleSection draft={draft} dispatch={dispatch} />
              )}
              <FiltersSection
                draft={draft}
                dispatch={dispatch}
                columns={columnNames}
              />
              <TransformsSection
                draft={draft}
                dispatch={dispatch}
                columns={columnNames}
              />
              <PayloadSection
                draft={draft}
                dispatch={dispatch}
                sampleRow={sampleRow}
                includedList={includedList}
                transforms={transformList}
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
