'use client';

/**
 * "what runs in this bridge" (one-time job vs live) plus, for live bridges,
 * the trigger config: polling watch or event-based CDC. owns the CDC
 * readiness probing flow.
 */
import type { Dispatch } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import type { QueryColumn } from '@syncle/core';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NumField } from './num-field';
import type { BuilderAction, BuilderDraft, WatchStrategy } from './draft';

export function TriggerSection({
  draft,
  dispatch,
  columns,
  sourceEngine,
  bridgeId,
}: {
  draft: Pick<
    BuilderDraft,
    | 'connectionId'
    | 'database'
    | 'schema'
    | 'table'
    | 'syncMode'
    | 'triggerKind'
    | 'watchStrategy'
    | 'watchColumn'
    | 'pollSeconds'
    | 'watchStartFrom'
    | 'cdcOps'
    | 'cdcStartFrom'
    | 'cdcSlot'
    | 'readiness'
    | 'checkingCdc'
  >;
  dispatch: Dispatch<BuilderAction>;
  columns: QueryColumn[];
  /** the source connection's engine; only PostgreSQL reports a TRUNCATE */
  sourceEngine?: string;
  /**
   * the bridge being edited, if it exists yet. a server with no replication
   * slot to spare must not fail the check for a bridge that already has one
   */
  bridgeId?: string | null;
}) {
  const t = useTranslations('bridgeBuilder');
  const {
    syncMode,
    triggerKind,
    watchStrategy,
    watchColumn,
    pollSeconds,
    watchStartFrom,
    cdcOps,
    cdcStartFrom,
    cdcSlot,
    readiness,
    checkingCdc,
  } = draft;

  async function checkReadiness() {
    if (!draft.connectionId || !draft.table) return;
    dispatch({ type: 'setCheckingCdc', checking: true });
    try {
      dispatch({
        type: 'setReadiness',
        readiness: await api.cdcReadiness({
          connectionId: draft.connectionId,
          database: draft.database || undefined,
          schema: draft.schema || undefined,
          table: draft.table,
          bridgeId: bridgeId || undefined,
          slot: sourceEngine === 'postgres' ? cdcSlot : undefined,
        }),
      });
    } catch (err) {
      toast.error(t('readinessFailed'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      dispatch({ type: 'setCheckingCdc', checking: false });
    }
  }

  return (
    <>
      {/* what runs in this bridge: an on-demand job or a live bridge */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t('whatRuns')}</h3>
        <div className="flex overflow-hidden rounded-md border text-xs">
          {(
            [
              ['oneTime', t('modeOneTime')],
              ['live', t('modeLive')],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => dispatch({ type: 'setSyncMode', syncMode: k })}
              className={cn(
                'flex-1 px-2.5 py-1.5 transition-colors',
                syncMode === k
                  ? 'bg-accent font-medium'
                  : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-muted-foreground text-[11px]">
          {syncMode === 'oneTime'
            ? t('oneTimeDesc')
            : t('liveDesc')}
        </p>
      </section>

      {/* trigger, live bridges only. one-time jobs are always a one-shot replay */}
      {syncMode === 'live' && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('howItListens')}</h3>
          <div className="flex overflow-hidden rounded-md border text-xs">
            {(
              [
                ['watch', t('polling')],
                ['cdc', t('eventBased')],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => dispatch({ type: 'setTriggerKind', triggerKind: k })}
                className={cn(
                  'flex-1 px-2.5 py-1.5 transition-colors',
                  triggerKind === k
                    ? 'bg-accent font-medium'
                    : 'text-muted-foreground hover:bg-accent/50',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {triggerKind === 'cdc' && (
            <div className="grid gap-2 rounded-md border p-2.5">
            <Label className="text-xs">{t('operationsToDeliver')}</Label>
            <div className="flex flex-wrap gap-3 text-xs">
              {(
                [
                  'insert',
                  'update',
                  'delete',
                  // a bridge saved with it keeps showing it, whatever the engine
                  ...(sourceEngine === 'postgres' || cdcOps.has('truncate')
                    ? (['truncate'] as const)
                    : []),
                ] as const
              ).map((op) => (
                <label key={op} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="accent-primary h-3.5 w-3.5"
                    checked={cdcOps.has(op)}
                    onChange={() => dispatch({ type: 'toggleCdcOp', op })}
                  />
                  {op === 'insert'
                    ? t('opInsert')
                    : op === 'update'
                      ? t('opUpdate')
                      : op === 'delete'
                        ? t('opDelete')
                        : t('opTruncate')}
                </label>
              ))}
            </div>
            {sourceEngine === 'postgres' && (
              <p className="text-muted-foreground text-[11px]">
                {t('truncateHint')}
              </p>
            )}

            <div className="grid gap-1.5">
              <Label className="text-xs">{t('startFrom')}</Label>
              <Select
                value={cdcStartFrom}
                onValueChange={(v) =>
                  dispatch({
                    type: 'setCdcStartFrom',
                    startFrom: v as 'now' | 'beginning',
                  })
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="now">{t('cdcFromNow')}</SelectItem>
                  <SelectItem value="beginning">{t('cdcFromBeginning')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-[11px]">
                {cdcStartFrom === 'beginning'
                  ? t('cdcFromBeginningHint')
                  : t('cdcFromNowHint')}
              </p>
            </div>

            {/* PostgreSQL only: a slot of its own, or the one all shared bridges of this connection read through */}
            {sourceEngine === 'postgres' && (
              <div className="grid gap-1.5">
                <Label className="text-xs">{t('cdcSlot')}</Label>
                <Select
                  value={cdcSlot}
                  onValueChange={(v) => dispatch({ type: 'setCdcSlot', slot: v as 'own' | 'shared' })}
                >
                  <SelectTrigger className="h-8" aria-label={t('cdcSlot')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="own">{t('cdcSlotOwn')}</SelectItem>
                    <SelectItem value="shared">{t('cdcSlotShared')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-[11px]">
                  {cdcSlot === 'shared' ? t('cdcSlotSharedHint') : t('cdcSlotOwnHint')}
                </p>
              </div>
            )}

            {/* readiness / setup */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-[11px]">
                {t('cdcDesc')}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={!draft.connectionId || !draft.table || checkingCdc}
                onClick={checkReadiness}
              >
                {checkingCdc ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('checkReadiness')}
              </Button>
            </div>

            {readiness && (
              <div className="space-y-1.5 rounded-md border p-2 text-[11px]">
                {!readiness.supported ? (
                  <p className="text-amber-600">
                    {readiness.instructions[0]}
                  </p>
                ) : (
                  <>
                    <p
                      className={cn(
                        'font-medium',
                        readiness.ready ? 'text-emerald-600' : 'text-amber-600',
                      )}
                    >
                      {readiness.ready
                        ? t('cdcReady')
                        : t('setupNeeded')}
                    </p>
                    {readiness.checks.map((c) => (
                      <div key={c.label} className="flex items-center gap-1.5">
                        <span className={c.ok ? 'text-emerald-600' : 'text-destructive'}>
                          {c.ok ? '✓' : '✗'}
                        </span>
                        <span>
                          {c.label}
                          {c.detail ? ` (${c.detail})` : ''}
                        </span>
                      </div>
                    ))}
                    {readiness.instructions.map((ins, i) => (
                      <p key={i} className="text-muted-foreground pl-1">
                        • {ins}
                      </p>
                    ))}
                    {/* not in the way of starting, but worth knowing first */}
                    {readiness.advisories?.map((note, i) => (
                      <p
                        key={`advisory-${i}`}
                        className="rounded bg-amber-500/10 px-1.5 py-1 text-amber-700 dark:text-amber-400"
                      >
                        <span className="font-medium">{t('goodToKnow')}</span>{' '}
                        {note}
                      </p>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {triggerKind === 'watch' && (
          <div className="grid gap-2 rounded-md border p-2.5">
            <div className="grid gap-1.5">
              <Label className="text-xs">{t('detectNewRowsBy')}</Label>
              <Select
                value={watchStrategy}
                onValueChange={(v) =>
                  dispatch({ type: 'setWatchStrategy', strategy: v as WatchStrategy })
                }
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="increment">
                    {t('strategyIncrement')}
                  </SelectItem>
                  <SelectItem value="timestamp">
                    {t('strategyTimestamp')}
                  </SelectItem>
                  <SelectItem value="snapshot">
                    {t('strategySnapshot')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {watchStrategy !== 'snapshot' && (
              <div className="grid gap-1.5">
                <Label className="text-xs">
                  {watchStrategy === 'timestamp'
                    ? t('timestampColumn')
                    : t('incrementingColumn')}
                </Label>
                <Select
                  value={watchColumn}
                  onValueChange={(v) => dispatch({ type: 'setWatchColumn', column: v })}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder={t('selectColumn')} />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c.name} value={c.name}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <NumField
                label={t('pollEvery')}
                value={pollSeconds}
                min={1}
                onChange={(v) => dispatch({ type: 'setPollSeconds', seconds: v })}
              />
              <div className="grid gap-1.5">
                <Label className="text-xs">{t('startFrom')}</Label>
                <Select
                  value={watchStartFrom}
                  onValueChange={(v) =>
                    dispatch({
                      type: 'setWatchStartFrom',
                      startFrom: v as 'now' | 'beginning',
                    })
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="now">{t('fromNow')}</SelectItem>
                    <SelectItem value="beginning">{t('fromBeginning')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
              <p className="text-muted-foreground text-[11px]">
                {t('watchDesc')}
              </p>
            </div>
          )}
        </section>
      )}
    </>
  );
}
