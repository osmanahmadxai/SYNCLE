'use client';

import { usePathname } from 'next/navigation';
import { DOC_PAGES, docHref } from '@/lib/docs';

/**
 * The docs page list: plain links, the one you are reading set in bold ink.
 * A client component only because it needs the pathname to know which.
 */
export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation" className="text-sm">
      <p className="font-serif font-semibold">Documentation</p>
      <ul className="mt-3 space-y-2">
        {DOC_PAGES.map((page) => {
          const href = docHref(page);
          const active =
            pathname === href ||
            pathname === `${href}/` ||
            (page.slug === '' && pathname === '/docs/');
          return (
            <li key={href}>
              <a
                href={href}
                aria-current={active ? 'page' : undefined}
                className={active ? 'font-semibold' : 'link'}
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
