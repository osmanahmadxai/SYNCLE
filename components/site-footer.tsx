import { Logo } from '@/components/logo';
import { AUTHOR_GITHUB, GITHUB } from '@/lib/content';

/**
 * The site footer, shared by the homepage and the docs pages. Hrefs are
 * root-relative so the same markup works from any route.
 */
export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8">
        <div className="grid gap-10 sm:grid-cols-3">
          <div>
            <Logo className="h-8 w-auto" />
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              Open-source database synchronization, running entirely on your
              own machines.
            </p>
          </div>

          <div>
            <h2 className="text-sm font-semibold">Documentation</h2>
            <ul className="mt-3 space-y-1 text-sm">
              {[
                ['/docs', 'Overview'],
                ['/docs/install', 'Installation'],
                ['/docs/quickstart', 'Quickstart'],
                ['/docs/bridges', 'How bridges work'],
                ['/docs/api', 'HTTP API'],
              ].map(([href, label]) => (
                <li key={href}>
                  <a href={href} className="link inline-block py-1">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="text-sm font-semibold">Project</h2>
            <ul className="mt-3 space-y-1 text-sm">
              {[
                [GITHUB, 'Source on GitHub'],
                [`${GITHUB}/releases/latest`, 'Releases'],
                [`${GITHUB}/issues`, 'Report an issue'],
                [`${GITHUB}/blob/main/LICENSE`, 'MIT licence'],
              ].map(([href, label]) => (
                <li key={href}>
                  <a href={href} rel="noopener" className="link inline-block py-1">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col justify-between gap-2 border-t pt-6 text-sm text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} Syncle. MIT licensed.</p>
          <p>
            Built by{' '}
            <a href={AUTHOR_GITHUB} rel="noopener" className="link">
              Osman Ahmadzai
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
