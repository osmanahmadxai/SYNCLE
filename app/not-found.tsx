import type { Metadata } from 'next';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Page not found',
  description: 'This page does not exist on syncle.dev.',
  robots: { index: false },
};

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-20 sm:px-8">
        <h1 className="text-3xl font-semibold">Page not found</h1>
        <p className="mt-4 leading-relaxed text-muted-foreground">
          There is nothing at this address. The <a href="/" className="link">homepage</a>{' '}
          and the <a href="/docs" className="link">documentation</a> are the
          two places everything on this site lives.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
