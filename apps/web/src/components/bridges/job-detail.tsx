'use client';

import { Ban, Loader2, Play, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { EndpointInfo, BridgeJob, BridgeJobStatus } from '@syncle/core';
import { ApiError } from '@/lib/api';
import {
  useCancelBridgeJob,
  useRetryFailed,
  useStartBridgeJob,
} from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DeliveryMonitor } from './delivery-log';

const STATUS_STYLES: Record<BridgeJobStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  completed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-destructive/15 text-destructive',
  canceling: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  canceled: 'bg-muted text-muted-foreground',
  paused: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  interrupted: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

export function JobStatusBadge({ status }: { status: BridgeJobStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        STATUS_STYLES[status],
      )}
    >
      {(status === 'running' ||
        status === 'queued' ||
        status === 'canceling') && <Loader2 className="h-3 w-3 animate-spin" />}
      {status}
    </span>
  );
}

const ACTIVE: BridgeJobStatus[] = ['queued', 'running', 'canceling'];
const RESUMABLE: BridgeJobStatus[] = [
  'failed',
  'canceled',
  'paused',
  'interrupted',
];

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'success' | 'danger' | 'warn' | 'muted';
}) {
  return (
    <div className="bg-card flex flex-col rounded-lg border px-3 py-2">
      <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
        {label}
      </span>
      <span
        className={cn(
          'text-lg font-semibold tabular-nums',
          tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'danger' && 'text-destructive',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function JobDetail({
  bridgeId,
  job,
  endpoint,
  isLive,
}: {
  bridgeId: string;
  job: BridgeJob;
  endpoint: EndpointInfo;
  /** live bridges (watch/CDC) are continuous listeners: no Cancel/Resume, no progress */
  isLive: boolean;
}) {
  const cancel = useCancelBridgeJob(bridgeId);
  const startJob = useStartBridgeJob(bridgeId);
  const retryFailed = useRetryFailed(bridgeId);

  const isActive = ACTIVE.includes(job.status);
  const total = job.totalCount;
  const settled = job.sentCount + job.failedCount + job.skippedCount;
  const pending = total != null ? Math.max(0, total - settled) : null;
  const pct =
    total && total > 0
      ? Math.min(100, Math.round((settled / total) * 100))
      : null;
  const attempted = job.sentCount + job.failedCount;
  const successRate =
    attempted > 0 ? Math.round((job.sentCount / attempted) * 100) : null;

  async function handleCancel() {
    try {
      await cancel.mutateAsync(job.id);
    } catch (err) {
      toast.error('Could not cancel', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleResume() {
    try {
      await startJob.mutateAsync({ resumeJobId: job.id });
      toast.success('Job resumed');
    } catch (err) {
      toast.error('Could not resume', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  async function handleRetry() {
    try {
      await retryFailed.mutateAsync(job.id);
      toast.success('Resending failed deliveries with the current config');
    } catch (err) {
      toast.error('Could not retry', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  // available whenever there are failures, including a live (CDC/watch) job
  const canRetry = job.failedCount > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header: status + actions */}
      <div className="flex items-center gap-3 px-4 pt-3">
        <JobStatusBadge status={job.status} />
        <span className="text-muted-foreground text-xs">
          {isLive
            ? isActive
              ? `listening since ${new Date(job.startedAt).toLocaleString()}`
              : `last active ${new Date(job.startedAt).toLocaleString()}`
            : `started ${new Date(job.startedAt).toLocaleString()}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* cancel/resume are job controls. a live bridge is started/stopped from
              the panel header above, "resuming" one would re-stream the whole table */}
          {!isLive && isActive && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleCancel}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Ban className="mr-1.5 h-3.5 w-3.5" />
              )}
              Cancel
            </Button>
          )}
          {canRetry && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleRetry}
              disabled={retryFailed.isPending}
            >
              {retryFailed.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Retry failed ({job.failedCount})
            </Button>
          )}
          {!isLive && RESUMABLE.includes(job.status) && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleResume}
              disabled={startJob.isPending}
            >
              {startJob.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1.5 h-3.5 w-3.5" />
              )}
              Resume
            </Button>
          )}
        </div>
      </div>

      {/* stat cards. a listener has no finite total/queue, so it shows a
          delivered/failed/skipped breakdown instead of progress-to-completion */}
      {isLive ? (
        <div className="grid grid-cols-2 gap-2 px-4 py-3 sm:grid-cols-4">
          <Stat
            label="Delivered"
            value={job.sentCount.toLocaleString()}
            tone="success"
          />
          <Stat
            label="Failed"
            value={job.failedCount.toLocaleString()}
            tone="danger"
          />
          <Stat
            label="Skipped"
            value={job.skippedCount.toLocaleString()}
            tone="warn"
          />
          <Stat
            label="Success"
            value={successRate != null ? `${successRate}%` : '—'}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 px-4 py-3 sm:grid-cols-6">
            <Stat
              label="Total"
              value={total != null ? total.toLocaleString() : '—'}
            />
            <Stat
              label="Delivered"
              value={job.sentCount.toLocaleString()}
              tone="success"
            />
            <Stat
              label="Failed"
              value={job.failedCount.toLocaleString()}
              tone="danger"
            />
            <Stat
              label="Skipped"
              value={job.skippedCount.toLocaleString()}
              tone="warn"
            />
            <Stat
              label="Queued"
              value={pending != null ? pending.toLocaleString() : '—'}
              tone="muted"
            />
            <Stat
              label="Success"
              value={successRate != null ? `${successRate}%` : '—'}
            />
          </div>

          {/* progress */}
          {pct != null && (
            <div className="px-4 pb-3">
              <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                <div
                  className="bg-primary h-full rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}
        </>
      )}

      {job.error && (
        <p className="bg-destructive/10 text-destructive break-words border-y px-4 py-2 text-xs">
          {job.error}
        </p>
      )}

      <div className="min-h-0 flex-1 border-t">
        <DeliveryMonitor
          bridgeId={bridgeId}
          jobId={job.id}
          live={isActive}
          totalRows={total}
          batchSize={job.batchSize}
          endpoint={endpoint}
        />
      </div>
    </div>
  );
}
