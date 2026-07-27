import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Providers } from '@/components/providers';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'Syncle — Sync any databases, live',
  description:
    'Keep any databases in sync across engines — PostgreSQL, MySQL, SQLite, MongoDB, Redis — in real time with CDC, polling, or one-shot replay. HTTP endpoints supported too.',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="bg-background text-foreground h-screen overflow-hidden antialiased">
        <NextIntlClientProvider messages={messages}>
          <Providers>{children}</Providers>
          <Toaster position="bottom-right" richColors />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
