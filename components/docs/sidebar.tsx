'use client';

import { usePathname } from 'next/navigation';
import { DOC_PAGES, docHref } from '@/lib/docs';

/**
 * The docs page list. A client component only because it highlights the page
 * being read, which needs the pathname.
 */
export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation">
      <p className="px-2 text-sm font-semibold">Documentation</p>
      <ul className="mt-2">
        {DOC_PAGES.map((page) => {
          const href = docHref(page);
          const active =
            pathname === href || pathname === `${href}/` || (page.slug === '' && pathname === '/docs/');
          return (
            <li key={href}>
              <a
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`block rounded px-2 py-1.5 text-sm ${
                  active
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                {page.title}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
