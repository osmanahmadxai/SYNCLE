'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Play, Radio, Square, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  useDeleteBridge,
  useBridgeJobs,
  useBridges,
  useStartBridgeJob,
  useStartWatch,
  useStopWatch,
} from '@/lib/queries';
import { destinationLabel, type EndpointInfo } from '@syncle/core';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { JobDetail, JobStatusBadge } from './job-detail';
import { WorkspaceMap } from './workspace-map';

export function BridgesView() {
  const t = useTranslations('bridges');
  const { selectedBridgeId, selectBridge } = useStudio();
  const { data: bridges } = useBridges();
  const bridge = bridges?.find((h) => h.id === selectedBridgeId) ?? null;

  // nothing selected → show the workspace map (the ecosystem view)
  if (!bridge) {
    return <WorkspaceMap />;
  }

  const dest = bridge.destination;
  const endpoint =
    dest.kind === 'http'
      ? { kind: 'http' as const, url: dest.url, method: dest.method }
      : {
          kind: 'database' as const,
          url: destinationLabel(dest),
          method: 'WRITE',
        };

  return (
    <BridgePanel
      key={bridge.id}
      bridgeId={bridge.id}
      bridgeName={bridge.name}
      sourceLabel={
        bridge.source.kind === 'table' ? bridge.source.table : t('customQuery')
      }
      destLabel={destinationLabel(dest)}
      endpoint={endpoint}
      isWatch={bridge.trigger.kind !== 'replay'}
      onDeleted={() => selectBridge(null)}
    />
  );
}

function BridgePanel({
  bridgeId,
  bridgeName,
  sourceLabel,
  destLabel,
  endpoint,
  isWatch,
  onDeleted,
}: {
  bridgeId: string;
  bridgeName: string;
  sourceLabel: string;
  destLabel: string;
  endpoint: EndpointInfo;
  isWatch: boolean;
  onDeleted: () => void;
}) {
  const confirm = useConfirm();
  const t = useTranslations('bridges');
  const tc = useTranslations('common');
  const { openBridgeEditor } = useStudio();
  const start = useStartBridgeJob(bridgeId);
  const startWatch = useStartWatch(bridgeId);
  const stopWatch = useStopWatch(bridgeId);
  const del = useDeleteBridge();
  const { data: jobs } = useBridgeJobs(bridgeId);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const listening = !!jobs?.some((r) =>
    ['queued', 'running', 'canceling'].includes(r.status),
  );

  // default to (and follow) the most recent job
  useEffect(() => {
    if (!jobs || jobs.length === 0) {
      setSelectedJobId(null);
      return;
    }
    setSelectedJobId((cur) =>
      cur && jobs.some((r) => r.id === cur) ? cur : jobs[0]!.id,
    );
  }, [jobs]);

  const selectedJob = jobs?.find((r) => r.id === selectedJobId) ?? null;

  async function handleRun() {
    try {
      const job = await start.mutateAsync({});
      setSelectedJobId(job.id);
      toast.success(t('jobStarted'));
    } catch (err) {
      toast.error(t('couldNotStartJob'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleStartWatch() {
    try {
      const job = await startWatch.mutateAsync();
      setSelectedJobId(job.id);
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
      title: t('deleteTitle', { name: bridgeName }),
      description: t('deleteDescription'),
      confirmText: tc('delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(bridgeId);
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
          <h2 className="truncate text-base font-semibold">{bridgeName}</h2>
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
              {t('runJob')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => openBridgeEditor({ editingId: bridgeId })}
          >
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            {tc('edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleDelete}>
            <Trash2 className="text-destructive h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* jobs strip */}

      {/* selected job */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedJob ? (
          <JobDetail
            bridgeId={bridgeId}
            job={selectedJob}
            endpoint={endpoint}
            isLive={isWatch}
          />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            {t('selectJob')}
          </div>
        )}
      </div>
    </div>
  );
}
