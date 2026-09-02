import type { Metadata } from 'next';
import { GITHUB } from '@/lib/content';
import { docBySlug, docHref, docNeighbours } from '@/lib/docs';

/**
 * The frame every docs page renders inside: the registry supplies the title,
 * the body is plain HTML styled by `.prose-docs`, and the footer carries the
 * prev/next links plus an edit link into the repository — the docs live in
 * the same repo as the product, under syncle-website/.
 */
export function DocArticle({
  slug,
  children,
}: {
  slug: string;
  children: React.ReactNode;
}) {
  const page = docBySlug(slug);
  const { prev, next } = docNeighbours(slug);
  const sourcePath = slug ? `app/docs/${slug}/page.tsx` : 'app/docs/page.tsx';

  return (
    <article className="prose-docs">
      <h1>{page?.title}</h1>
      {children}

      <footer className="mt-14">
        <nav aria-label="Adjacent pages" className="flex justify-between gap-4 border-t pt-5 text-sm">
          <span>
            {prev && (
              <a href={docHref(prev)} className="link">
                ← {prev.title}
              </a>
            )}
          </span>
          <span>
            {next && (
              <a href={docHref(next)} className="link">
                {next.title} →
              </a>
            )}
          </span>
        </nav>
        <p className="mt-5 text-xs text-muted-foreground">
          Found a mistake?{' '}
          <a
            href={`${GITHUB}/edit/main/website/${sourcePath}`}
            rel="noopener"
            className="link"
          >
            Edit this page on GitHub
          </a>
          .
        </p>
      </footer>
    </article>
  );
}

/** the metadata export for a docs page, derived from the registry */
export function docMetadata(slug: string): Metadata {
  const page = docBySlug(slug);
  if (!page) return {};
  // the root layout's title template appends "· Syncle"
  return {
    title: slug ? `${page.title} — Docs` : 'Documentation',
    description: page.description,
    alternates: { canonical: docHref(page) },
  };
}
