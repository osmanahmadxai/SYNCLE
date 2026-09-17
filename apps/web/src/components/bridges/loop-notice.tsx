'use client';

/**
 * a bridge that is tied to others in a ring — it reads a table another bridge
 * writes, and writes a table a live bridge reads (A -> B plus B -> A). Syncle
 * keeps its own writes from going round again; this line says so, names the
 * other bridges, and counts what was held back, so that "why did this change
 * not go back?" has an answer on the page. silent for every other bridge.
 *
 * with the guard switched off (SYNCLE_ECHO_TTL_SECONDS=0) such a pair WILL
 * loop: that is a warning, not a note.
 */
import { useTranslations } from 'next-intl';
import { AlertTriangle, Repeat2 } from 'lucide-react';
import { useBridgeLoops } from '@/lib/queries';
import { cn } from '@/lib/utils';

export function LoopNotice({ bridgeId }: { bridgeId: string }) {
  const t = useTranslations('loopNotice');
  const { data: status } = useBridgeLoops(bridgeId);
  if (!status || status.fedBy.length === 0 || status.feeds.length === 0)
    return null;
  // the bridges on both sides of this one; usually the same one, named once
  const names = [
    ...new Map(
      [...status.fedBy, ...status.feeds].map((p) => [p.bridgeId, p.name]),
    ).values(),
  ];
  const Icon = status.guard ? Repeat2 : AlertTriangle;

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 border-b px-4 py-1.5 text-xs',
        status.guard
          ? 'text-muted-foreground'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p>
          {t(status.guard ? 'tied' : 'unguarded', {
            count: names.length,
            names: names.join(', '),
          })}
        </p>
        {status.guard && status.heldBack > 0 && (
          <p>{t('heldBack', { count: status.heldBack })}</p>
        )}
      </div>
    </div>
  );
}
