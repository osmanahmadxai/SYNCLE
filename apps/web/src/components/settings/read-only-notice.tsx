'use client';

/**
 * an account that may look and not change (a viewer) is told so, once, where it
 * sees it — instead of finding out from a refused request. nothing is shown to
 * anybody else
 */
import { useTranslations } from 'next-intl';
import { Eye } from 'lucide-react';
import { useAuthStatus } from '@/lib/queries';

export function ReadOnlyNotice() {
  const { data: status } = useAuthStatus();
  if (status?.user?.role !== 'viewer') return null;
  return <ReadOnlyLine />;
}

export function ReadOnlyLine() {
  const t = useTranslations('userMenu');
  return (
    <p
      role="status"
      className="text-muted-foreground flex items-start gap-1.5 border-b px-3 py-1.5 text-[11px]"
    >
      <Eye className="mt-0.5 h-3 w-3 shrink-0" />
      {t('viewerNotice')}
    </p>
  );
}
