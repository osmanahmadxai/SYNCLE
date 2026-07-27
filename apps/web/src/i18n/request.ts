import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

// Supported UI locales. Chinese is the default so the app shows 中文 out of the
// box; the language toggle writes a `NEXT_LOCALE` cookie to switch.
export const locales = ['zh', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get('NEXT_LOCALE')?.value;
  const locale: Locale =
    cookieLocale && (locales as readonly string[]).includes(cookieLocale)
      ? (cookieLocale as Locale)
      : defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
