'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Play, Radio, Square, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  useDeleteHook,
  useHookRuns,
  useHooks,
  useStartHookRun,
  useStartWatch,
  useStopWatch,
} from '@/lib/queries';
import { destinationLabel, type EndpointInfo } from '@syncle/core';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { RunDetail, RunStatusBadge } from './run-detail';
import { WorkspaceMap } from './workspace-map';

export function AutomationsView() {
  const t = useTranslations('automations');
  const { selectedHookId, selectHook } = useStudio();
  const { data: hooks } = useHooks();
  const hook = hooks?.find((h) => h.id === selectedHookId) ?? null;

  // nothing selected → show the workspace map (the ecosystem view)
  if (!hook) {
    return <WorkspaceMap />;
  }

  const dest = hook.destination;
  const endpoint =
    dest.kind === 'http'
      ? { kind: 'http' as const, url: dest.url, method: dest.method }
      : {
          kind: 'database' as const,
          url: destinationLabel(dest),
          method: 'WRITE',
        };

  return (
    <HookPanel
      key={hook.id}
      hookId={hook.id}
      hookName={hook.name}
      sourceLabel={
        hook.source.kind === 'table' ? hook.source.table : t('customQuery')
      }
      destLabel={destinationLabel(dest)}
      endpoint={endpoint}
      isWatch={hook.trigger.kind !== 'replay'}
      onDeleted={() => selectHook(null)}
    />
  );
}

function HookPanel({
  hookId,
  hookName,
  sourceLabel,
  destLabel,
  endpoint,
  isWatch,
  onDeleted,
}: {
  hookId: string;
  hookName: string;
  sourceLabel: string;
  destLabel: string;
  endpoint: EndpointInfo;
  isWatch: boolean;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const t = useTranslations('automations');
  const tc = useTranslations('common');
  const { openHookEditor } = useStudio();
  const start = useStartHookRun(hookId);
  const startWatch = useStartWatch(hookId);
  const stopWatch = useStopWatch(hookId);
  const del = useDeleteHook();
  const { data: runs } = useHookRuns(hookId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const listening = !!runs?.some((r) =>
    ['queued', 'running', 'canceling'].includes(r.status),
  );

  // default to (and follow) the most recent run
  useEffect(() => {
    if (!runs || runs.length === 0) {
      setSelectedRunId(null);
      return;
    }
    setSelectedRunId((cur) =>
      cur && runs.some((r) => r.id === cur) ? cur : runs[0]!.id,
    );
  }, [runs]);

  const selectedRun = runs?.find((r) => r.id === selectedRunId) ?? null;

  async function handleRun() {
    try {
      const run = await start.mutateAsync({});
      setSelectedRunId(run.id);
      toast.success(t('runStarted'));
    } catch (err) {
      toast.error(t('couldNotStartRun'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleStartWatch() {
    try {
      const run = await startWatch.mutateAsync();
      setSelectedRunId(run.id);
      toast.success(t('listeningForData'));
    } catch (err) {
      toast.error(t('couldNotStartListening'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleStopWatch() {
    try {
      await stopWatch.mutateAsync();
      toast.success(t('stoppedListening'));
    } catch (err) {
      toast.error(t('couldNotStop'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: t('deleteTitle', { name: hookName }),
      description: t('deleteDescription'),
      confirmText: tc('delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(hookId);
      onDeleted();
      toast.success(t('bridgeDeleted'));
    } catch (err) {
      toast.error(t('couldNotDelete'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{hookName}</h2>
          <p className="text-muted-foreground truncate font-mono text-xs">
            {sourceLabel} → {destLabel}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isWatch ? (
            listening ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleStopWatch}
                disabled={stopWatch.isPending}
              >
                {stopWatch.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Square className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('stopListening')}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleStartWatch}
                disabled={startWatch.isPending}
              >
                {startWatch.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Radio className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('startListening')}
              </Button>
            )
          ) : (
            <Button size="sm" onClick={handleRun} disabled={start.isPending}>
              {start.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('run')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => openHookEditor({ editingId: hookId })}
          >
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            {tc('edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDelete}>
            <Trash2 className="text-destructive h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* runs strip */}

      {/* selected run */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedRun ? (
          <RunDetail
            hookId={hookId}
            run={selectedRun}
            endpoint={endpoint}
            isHook={isWatch}
          />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {t('selectRun')}
          </div>
        )}
      </div>
    </div>
  );
}
