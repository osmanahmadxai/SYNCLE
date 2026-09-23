'use client';

/**
 * a change of master key, while one is under way: the new key is in place, the
 * previous one is still accepted, and what matters is whether anything still
 * DEPENDS on the previous one — because that is when it can be taken out.
 * nothing at all is shown on an instance that has no previous key: there is
 * nothing to say about a key nobody is changing.
 */
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import type { KeyRotationReport } from '@/lib/api';
import { useEncryptionStatus, useRotateEncryption } from '@/lib/queries';
import { Button } from '@/components/ui/button';

export function EncryptionStatus() {
  const { data } = useEncryptionStatus(true);
  const rotate = useRotateEncryption();
  if (!data || data.previousKeys === 0) return null;
  return (
    <EncryptionReport
      report={data}
      busy={rotate.isPending}
      onCheck={() => rotate.mutate()}
    />
  );
}

export function EncryptionReport({
  report,
  busy,
  onCheck,
}: {
  report: KeyRotationReport;
  busy: boolean;
  onCheck: () => void;
}) {
  const t = useTranslations('settingsDialog.encryption');
  const stuck = report.unreadable > 0;
  const Icon = stuck ? AlertTriangle : CheckCircle2;
  return (
    <section className="space-y-2 rounded-md border p-3 text-sm">
      <h4 className="flex items-center gap-2 font-medium">
        <KeyRound className="h-4 w-4" />
        {t('title')}
      </h4>
      <p className="text-muted-foreground text-xs">
        {t('previous', { count: report.previousKeys })}
      </p>
      <p
        role="status"
        className={
          stuck
            ? 'flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400'
            : 'flex items-start gap-2 text-xs text-emerald-700 dark:text-emerald-400'
        }
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {stuck ? t('unreadable', { count: report.unreadable }) : t('done')}
      </p>
      {report.reencrypted > 0 && (
        <p className="text-muted-foreground text-xs">
          {t('moved', { count: report.reencrypted })}
        </p>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={busy}
        onClick={onCheck}
      >
        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        {t('check')}
      </Button>
    </section>
  );
}
