'use client';

/**
 * Verify: is the destination the copy of the source this bridge says it is?
 *
 * Every delivery of a bridge can be green and the two ends still disagree — a
 * row edited by hand at the destination, a delete that happened while the
 * bridge was stopped, a table restored from last week's backup. None of those
 * is a failed delivery. This looks: every row from both ends, compared by what
 * kind of value each column holds.
 *
 * What it found is shown as counts and a few examples, with both readings of
 * every column that differs — so that "different" can be judged, not believed.
 * Reconcile writes what is missing or different from the source as it is NOW.
 * Removing rows that are only in the destination is a separate, explicit tick:
 * it is the one thing here that cannot be re-read from the source afterwards.
 */
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ScanSearch,
  Wrench,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  remainingDifferences,
  type BridgeVerification,
  type VerificationTargetResult,
} from '@syncle/core';
import { ApiError } from '@/lib/api';
import {
  useCancelVerification,
  useStartVerification,
  useVerifications,
} from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const ACTIVE = ['queued', 'running', 'canceling'];

/** a key, or a value, as one short piece of text */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** how a finished verification turned out, for its icon and colour */
export function verdictOf(
  v: BridgeVerification,
): 'running' | 'inSync' | 'differs' | 'unknown' | 'failed' | 'canceled' {
  if (ACTIVE.includes(v.status)) return 'running';
  if (v.status === 'failed') return 'failed';
  if (v.status === 'canceled') return 'canceled';
  if (v.inSync === null) return 'unknown';
  return v.inSync ? 'inSync' : 'differs';
}

export function VerifyDialog({
  bridgeId,
  open,
  onOpenChange,
}: {
  bridgeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('verify');
  const { data: list, isLoading } = useVerifications(bridgeId, open);
  const start = useStartVerification(bridgeId);
  const cancel = useCancelVerification(bridgeId);
  const [deleteExtra, setDeleteExtra] = useState(false);
  const latest = list?.[0] ?? null;
  const busy = !!latest && ACTIVE.includes(latest.status);

  async function run(mode: 'verify' | 'reconcile') {
    try {
      await start.mutateAsync({
        mode,
        deleteExtra: mode === 'reconcile' && deleteExtra,
      });
    } catch (err) {
      toast.error(t('couldNotStart'), {
        description: err instanceof ApiError ? err.message : String(err),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy || start.isPending}
            onClick={() => void run('verify')}
          >
            <ScanSearch className="mr-1.5 h-3.5 w-3.5" />
            {t('verifyNow')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || start.isPending}
            onClick={() => void run('reconcile')}
          >
            <Wrench className="mr-1.5 h-3.5 w-3.5" />
            {t('reconcile')}
          </Button>
          {busy && latest && (
            <Button
              size="sm"
              variant="ghost"
              disabled={cancel.isPending || latest.status === 'canceling'}
              onClick={() => cancel.mutate(latest.id)}
            >
              {t('cancel')}
            </Button>
          )}
        </div>
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-primary mt-0.5"
            checked={deleteExtra}
            disabled={busy}
            onChange={(e) => setDeleteExtra(e.target.checked)}
          />
          <span>
            <span className="font-medium">{t('deleteExtra')}</span>
            <span className="text-muted-foreground block">
              {t('deleteExtraHint')}
            </span>
          </span>
        </label>

        {isLoading && (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {!isLoading && !latest && (
          <p className="text-muted-foreground py-4 text-sm">{t('never')}</p>
        )}
        {latest && <VerificationReport verification={latest} />}

        {list && list.length > 1 && (
          <div className="space-y-1 border-t pt-3">
            <h4 className="text-xs font-semibold">{t('earlier')}</h4>
            <ul className="space-y-0.5 text-xs">
              {list.slice(1).map((v) => (
                <HistoryLine key={v.id} verification={v} />
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const TONE: Record<ReturnType<typeof verdictOf>, string> = {
  running: 'text-sky-600 dark:text-sky-400',
  inSync: 'text-emerald-600 dark:text-emerald-400',
  differs: 'text-amber-700 dark:text-amber-400',
  unknown: 'text-muted-foreground',
  failed: 'text-destructive',
  canceled: 'text-muted-foreground',
};

function VerdictIcon({ verdict }: { verdict: ReturnType<typeof verdictOf> }) {
  const Icon =
    verdict === 'running'
      ? Loader2
      : verdict === 'inSync'
        ? CheckCircle2
        : verdict === 'failed'
          ? XCircle
          : AlertTriangle;
  return (
    <Icon
      className={cn(
        'h-4 w-4 shrink-0',
        TONE[verdict],
        verdict === 'running' && 'animate-spin',
      )}
    />
  );
}

function HistoryLine({
  verification: v,
}: {
  verification: BridgeVerification;
}) {
  const t = useTranslations('verify');
  const format = useFormatter();
  const verdict = verdictOf(v);
  return (
    <li className="flex items-center gap-2">
      <VerdictIcon verdict={verdict} />
      <span className="text-muted-foreground">
        {format.dateTime(new Date(v.startedAt), {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
      <span>{t(`mode.${v.mode}`)}</span>
      <span className={TONE[verdict]}>{t(`verdict.${verdict}`)}</span>
    </li>
  );
}

export function VerificationReport({
  verification: v,
}: {
  verification: BridgeVerification;
}) {
  const t = useTranslations('verify');
  const format = useFormatter();
  const verdict = verdictOf(v);
  const percent =
    v.sourceTotal && v.sourceTotal > 0
      ? Math.min(100, Math.round((v.sourceRows / v.sourceTotal) * 100))
      : null;

  return (
    <div className="space-y-3">
      <div
        role="status"
        className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
      >
        <VerdictIcon verdict={verdict} />
        <div className="min-w-0 space-y-0.5">
          <p className={cn('font-medium', TONE[verdict])}>
            {t(`mode.${v.mode}`)} · {t(`verdict.${verdict}`)}
          </p>
          <p className="text-muted-foreground text-xs">
            {t('rowsRead', { count: v.sourceRows })}
            {percent !== null && verdict === 'running' ? ` · ${percent}%` : ''}
            {' · '}
            {format.dateTime(new Date(v.startedAt), {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </p>
          {v.error && (
            <p className="text-destructive break-words text-xs">{v.error}</p>
          )}
        </div>
      </div>
      {v.targets.map((target) => (
        <TargetReport
          key={`${target.connectionId}:${target.target}`}
          target={target}
          reconciled={v.mode === 'reconcile'}
        />
      ))}
    </div>
  );
}

function TargetReport({
  target,
  reconciled,
}: {
  target: VerificationTargetResult;
  reconciled: boolean;
}) {
  const t = useTranslations('verify');
  const left = remainingDifferences(target);
  return (
    <section className="space-y-2 rounded-md border p-3 text-xs">
      <h4 className="flex items-center gap-2 font-mono text-[13px] font-semibold">
        {target.target}
        {!target.unsupported && (
          <span
            className={cn(
              'font-sans text-[11px] font-normal',
              left === 0 ? TONE.inSync : TONE.differs,
            )}
          >
            {left === 0
              ? t('targetInSync')
              : t('targetDiffers', { count: left })}
          </span>
        )}
      </h4>
      {target.unsupported ? (
        <p className="text-muted-foreground">{target.unsupported}</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <Count label={t('checked')} value={target.checked} />
            <Count label={t('missing')} value={target.missing} bad />
            <Count label={t('different')} value={target.different} bad />
            <Count label={t('extra')} value={target.extra} bad />
            {reconciled && <Count label={t('fixed')} value={target.fixed} />}
            {reconciled && (
              <Count label={t('removed')} value={target.removed} />
            )}
          </dl>
          {target.samples.missing.length > 0 && (
            <Keys
              title={t('missingSample', {
                shown: target.samples.missing.length,
                count: target.missing,
              })}
              keys={target.samples.missing}
            />
          )}
          {target.samples.extra.length > 0 && (
            <Keys
              title={t('extraSample', {
                shown: target.samples.extra.length,
                count: target.extra ?? 0,
              })}
              keys={target.samples.extra}
            />
          )}
          {target.samples.different.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium">
                {t('differentSample', {
                  shown: target.samples.different.length,
                  count: target.different,
                })}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="pr-3 font-normal">{t('key')}</th>
                      <th className="pr-3 font-normal">{t('column')}</th>
                      <th className="pr-3 font-normal">{t('inSource')}</th>
                      <th className="font-normal">{t('inDestination')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {target.samples.different.flatMap((d) =>
                      d.columns.map((c) => (
                        <tr
                          key={`${cell(d.key)}:${c.column}`}
                          className="align-top"
                        >
                          <td className="pr-3">{d.key.map(cell).join(', ')}</td>
                          <td className="pr-3">{c.column}</td>
                          <td
                            className="max-w-[220px] truncate pr-3"
                            title={cell(c.expected)}
                          >
                            {cell(c.expected)}
                          </td>
                          <td
                            className="max-w-[220px] truncate"
                            title={cell(c.actual)}
                          >
                            {cell(c.actual)}
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      {target.notes.map((note) => (
        <p key={note} className="text-muted-foreground">
          {note}
        </p>
      ))}
    </section>
  );
}

function Count({
  label,
  value,
  bad,
}: {
  label: string;
  value: number | null;
  bad?: boolean;
}) {
  const t = useTranslations('verify');
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('font-mono text-sm', bad && !!value && TONE.differs)}>
        {value === null ? t('notLookedFor') : value.toLocaleString('en-US')}
      </dd>
    </div>
  );
}

function Keys({ title, keys }: { title: string; keys: unknown[][] }) {
  return (
    <div className="space-y-0.5">
      <p className="font-medium">{title}</p>
      <p className="break-words font-mono text-[11px]">
        {keys.map((key) => key.map(cell).join(', ')).join(' · ')}
      </p>
    </div>
  );
}
