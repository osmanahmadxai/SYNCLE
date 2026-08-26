import { Logo } from '@/components/logo';
import { GITHUB } from '@/lib/content';

/**
 * The site header, shared by the homepage and the docs pages. Text links
 * for reading, two small flat buttons for doing; not sticky — the page
 * scrolls past it the way a document does.
 */
export function SiteHeader({ current }: { current?: 'docs' }) {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5 sm:px-8">
        <a href="/" aria-label="Syncle — home">
          <Logo className="h-8 w-auto sm:h-9" priority />
        </a>
        <nav className="flex items-center gap-4 text-sm sm:gap-5">
          <a
            href="/#how-it-works"
            className="hidden py-2 hover:underline hover:underline-offset-4 md:inline-block"
          >
            How it works
          </a>
          <a
            href="/docs"
            aria-current={current === 'docs' ? 'page' : undefined}
            className={`py-2 hover:underline hover:underline-offset-4 ${
              current === 'docs' ? 'font-semibold' : ''
            }`}
          >
            Docs
          </a>
          <a
            href={GITHUB}
            rel="noopener"
            className="btn btn-quiet btn-sm hidden sm:inline-flex"
          >
            GitHub
          </a>
          <a href="/#install" className="btn btn-primary btn-sm">
            Install
          </a>
        </nav>
      </div>
    </header>
  );
}
