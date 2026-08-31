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
      <SiteHeader current="docs" wide />
      <div className="mx-auto max-w-[72rem] px-6">
        <div className="gap-12 pb-16 pt-4 lg:grid lg:grid-cols-[13rem_minmax(0,56rem)]">
          <aside className="mb-12 lg:mb-0">
            <div className="lg:sticky lg:top-8">
              <DocsSidebar />
            </div>
          </aside>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
      <SiteFooter wide />
    </>
  );
}
