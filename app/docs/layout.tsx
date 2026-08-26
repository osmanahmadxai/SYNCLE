import { DocsSidebar } from '@/components/docs/sidebar';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';

/**
 * The docs shell: page list on the left, one article on the right. On
 * phones the list moves above the article — no drawer, nothing to toggle.
 */
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader current="docs" />
      <div className="mx-auto max-w-5xl px-5 sm:px-8">
        <div className="gap-10 py-10 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:py-12">
          <aside className="mb-10 lg:mb-0">
            <div className="lg:sticky lg:top-8">
              <DocsSidebar />
            </div>
          </aside>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
      <SiteFooter />
    </>
  );
}
