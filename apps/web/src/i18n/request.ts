import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isLocale, locales } from './locales';

// Which locales exist is derived from src/messages/ — see ./locales.ts. The
// language toggle writes a `NEXT_LOCALE` cookie to switch between them.
export { defaultLocale, locales };

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get('NEXT_LOCALE')?.value;
  const locale = isLocale(cookieLocale) ? (cookieLocale as string) : defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
