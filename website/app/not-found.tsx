import type { Metadata } from 'next';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { MEASURE } from '@/lib/layout';

export const metadata: Metadata = {
  title: 'Page not found',
  description: 'This page does not exist on syncle.dev.',
  robots: { index: false },
};

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className={`mx-auto px-6 py-16 text-[18px] leading-[1.75] ${MEASURE}`}>
        <h1 className="text-[2rem]">Page not found</h1>
        <p className="mt-4 text-muted-foreground">
          There is nothing at this address. The <a href="/" className="link">homepage</a>{' '}
          and the <a href="/docs" className="link">documentation</a> are the
          two places everything on this site lives.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
