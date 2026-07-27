'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * Flips the UI language by writing the `NEXT_LOCALE` cookie that
 * src/i18n/request.ts reads on the server, then refreshing server components
 * so the new messages load. The label shows the CURRENT language.
 */
export function LangToggle() {
  const locale = useLocale();
  const t = useTranslations('lang');
  const router = useRouter();
  const next = locale === 'zh' ? 'en' : 'zh';

  function switchLocale() {
    document.cookie = `NEXT_LOCALE=${next};path=/;max-age=31536000;samesite=lax`;
    router.refresh();
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      aria-label={t('ariaLabel')}
      title={t('ariaLabel')}
      onClick={switchLocale}
    >
      <span className="text-xs font-medium">{locale === 'zh' ? '中' : 'EN'}</span>
    </Button>
  );
}
