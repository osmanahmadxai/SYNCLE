/**
 * The docs registry: one entry per page, in reading order. The sidebar, the
 * prev/next links, and the sitemap are all derived from this list, so a new
 * page only has to be added here once.
 */
export type DocPage = {
  slug: string; // '' is the overview at /docs
  title: string;
  /** used for <title> and the meta description */
  description: string;
};

export const DOC_PAGES: DocPage[] = [
  {
    slug: '',
    title: 'Overview',
    description:
      'What Syncle is, the pieces it is made of, and where to start reading.',
  },
  {
    slug: 'install',
    title: 'Installation',
    description:
      'The one-command install, the syncle launcher, the manual Docker Compose route, ports, and updating or removing an install.',
  },
  {
    slug: 'quickstart',
    title: 'Quickstart',
    description:
      'From syncle up to a first working bridge: the setup token, connecting a database, and reading the delivery timeline.',
  },
  {
    slug: 'bridges',
    title: 'How bridges work',
    description:
      'Bridges, jobs and deliveries; the three trigger modes; delivery guarantees; destinations; and the tuning knobs.',
  },
  {
    slug: 'cdc',
    title: 'CDC setup',
    description:
      'Per-engine prerequisites for real-time change data capture, what Syncle provisions for you, and the honest limitations.',
  },
  {
    slug: 'workbench',
    title: 'Database workbench',
    description:
      'Browsing and editing tables, the query editor, schema and ER diagrams, DDL, backup and restore, and SSH tunnels.',
  },
  {
    slug: 'configuration',
    title: 'Configuration',
    description:
      'Every environment variable with its default, the in-app settings, and where the config files live.',
  },
  {
    slug: 'api',
    title: 'HTTP API',
    description:
      'The REST API under /api: authentication, response envelopes, and every endpoint for connections, bridges and jobs.',
  },
  {
    slug: 'self-hosting',
    title: 'Self-hosting & security',
    description:
      'Running Syncle beyond localhost: the security posture, encryption, what to back up, and a troubleshooting list.',
  },
];

export function docHref(page: DocPage): string {
  return page.slug ? `/docs/${page.slug}` : '/docs';
}

export function docBySlug(slug: string): DocPage | undefined {
  return DOC_PAGES.find((p) => p.slug === slug);
}

/** the pages before and after `slug` in reading order */
export function docNeighbours(slug: string): {
  prev?: DocPage;
  next?: DocPage;
} {
  const i = DOC_PAGES.findIndex((p) => p.slug === slug);
  if (i === -1) return {};
  return { prev: DOC_PAGES[i - 1], next: DOC_PAGES[i + 1] };
}
