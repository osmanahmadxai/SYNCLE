'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useLocaleList } from '@/i18n/locale-list';

/** what a language calls itself — "中文", "italiano" — falling back to the code */
function endonym(locale: string): string {
  try {
    return (
      new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale
    );
  } catch {
    return locale;
  }
}

/**
 * Cycles the UI language by writing the `NEXT_LOCALE` cookie that
 * src/i18n/request.ts reads on the server, then refreshing server components so
 * the new messages load. The languages on offer come from the message files
 * themselves, so adding one needs no change here. The label shows the CURRENT
 * language; the tooltip names the one a click switches to.
 */
export function LangToggle() {
  const locale = useLocale();
  const locales = useLocaleList();
  const t = useTranslations('lang');
  const router = useRouter();

  const next = locales[(locales.indexOf(locale) + 1) % locales.length] ?? locale;

  function switchLocale() {
    document.cookie = `NEXT_LOCALE=${next};path=/;max-age=31536000;samesite=lax`;
    router.refresh();
  }

  // one language shipped means nothing to switch to
  if (locales.length < 2) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      aria-label={t('ariaLabel')}
      title={`${t('ariaLabel')} — ${endonym(next)}`}
      onClick={switchLocale}
    >
      <span className="text-xs font-medium uppercase">{locale}</span>
    </Button>
  );
}
