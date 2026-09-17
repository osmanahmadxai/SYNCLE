'use client';

/**
 * the dead-letter queue of a live bridge: rows it could not deliver and set
 * aside (in full) instead of losing them when the source's change log moved on.
 * collapsed to one line while there is nothing to decide; expands to show each
 * entry's rows and error, with retry / discard per entry or for all of them.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronRight,
  Inbox,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import type { BridgeDeadLetter } from '@syncle/core';
import { ApiError } from '@/lib/api';
import {
  useDeadLetters,
  useDiscardDeadLetters,
  useRetryDeadLetters,
} from '@/lib/queries';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';

const OP_STYLES: Record<string, string> = {
  insert: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  update: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  delete: 'bg-destructive/15 text-destructive',
};

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

export function DeadLetterPanel({
  bridgeId,
  live,
}: {
  bridgeId: string;
  live: boolean;
}) {
  const t = useTranslations('deadLetters');
  const confirm = useConfirm();
  const { data } = useDeadLetters(bridgeId, live);
  const retry = useRetryDeadLetters(bridgeId);
  const discard = useDiscardDeadLetters(bridgeId);
  const [open, setOpen] = useState(false);

  // nothing waiting: the panel stays out of the way entirely
  if (!data || data.pendingEntries === 0) return null;

  const busy = retry.isPending || discard.isPending;

  async function handleRetry(ids?: string[], force = false) {
    try {
      const res = await retry.mutateAsync({ ids, force });
      if (res.resolved > 0)
        toast.success(t('retryResolved', { count: res.resolved }));
      if (res.stillFailing > 0)
        toast.error(t('retryStillFailing', { count: res.stillFailing }));
      if (res.needsForce > 0)
        toast.warning(t('retryNeedsForce', { count: res.needsForce }));
    } catch (err) {
      toast.error(t('couldNotRetry'), { description: errorText(err) });
    }
  }

  async function handleDiscard(ids?: string[]) {
    const count = ids ? ids.length : (data?.pendingEntries ?? 0);
    const ok = await confirm({
      title: t('discardTitle'),
      description: t('discardDescription', { count }),
      confirmText: t('discard'),
      destructive: true,
    });
    if (!ok) return;
    try {
      const res = await discard.mutateAsync({ ids });
      toast.success(t('discarded', { count: res.discarded }));
    } catch (err) {
      toast.error(t('couldNotDiscard'), { description: errorText(err) });
    }
  }

  return (
    <div className="border-y border-amber-500/30 bg-amber-500/10">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 text-left text-xs font-medium text-amber-700 dark:text-amber-300"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <Inbox className="h-3.5 w-3.5 shrink-0" />
          <span>{t('waiting', { count: data.pendingRows })}</span>
        </button>
        <span className="text-muted-foreground hidden text-xs sm:inline">
          {t('explainer')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => handleRetry()}
          >
            {retry.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('retryAll')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => handleDiscard()}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t('discardAll')}
          </Button>
        </div>
      </div>

      {open && (
        <ul className="bg-background/60 max-h-72 divide-y overflow-y-auto border-t border-amber-500/30">
          {data.items.map((entry) => (
            <DeadLetterRow
              key={entry.id}
              entry={entry}
              busy={busy}
              onRetry={(force) => handleRetry([entry.id], force)}
              onDiscard={() => handleDiscard([entry.id])}
            />
          ))}
          {data.pendingEntries > data.items.length && (
            <li className="text-muted-foreground px-4 py-2 text-xs">
              {t('moreNotShown', {
                count: data.pendingEntries - data.items.length,
              })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function DeadLetterRow({
  entry,
  busy,
  onRetry,
  onDiscard,
}: {
  entry: BridgeDeadLetter;
  busy: boolean;
  onRetry: (force: boolean) => void;
  onDiscard: () => void;
}) {
  const t = useTranslations('deadLetters');

  return (
    <li className="space-y-1.5 px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {entry.op && (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 font-medium uppercase tracking-wide',
              OP_STYLES[entry.op],
            )}
          >
            {entry.op}
          </span>
        )}
        <span className="text-muted-foreground">
          {t('entryMeta', {
            rows: entry.rowCount,
            sequence: entry.sequence,
            attempts: entry.attempts,
          })}
        </span>
        <span className="text-muted-foreground">
          {new Date(entry.createdAt).toLocaleString()}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onRetry(false)}
          >
            {t('retry')}
          </Button>
          {entry.needsForce && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onRetry(true)}
            >
              {t('forceRetry')}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
            {t('discard')}
          </Button>
        </div>
      </div>
      {entry.error && (
        <p className="text-destructive break-words">{entry.error}</p>
      )}
      <pre className="bg-muted/60 max-h-32 overflow-auto rounded p-2 font-mono text-[11px] leading-relaxed">
        {JSON.stringify(
          entry.rows.length === 1 ? entry.rows[0] : entry.rows,
          null,
          2,
        )}
      </pre>
    </li>
  );
}
