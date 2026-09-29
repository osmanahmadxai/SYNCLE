import {
  AUTHOR_GITHUB,
  DESCRIPTION,
  FAQ,
  GITHUB,
  SITE_URL,
  TITLE,
} from '@/lib/content';

/**
 * The FAQ graph, rendered only by the page that shows those questions —
 * the docs overview. Structured data has to mirror text a reader can see,
 * so this travels with the visible list rather than sitting in the layout.
 */
export function FaqStructuredData() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          '@id': `${SITE_URL}/docs#faq`,
          mainEntity: FAQ.map((item) => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a },
          })),
        }),
      }}
    />
  );
}

/**
 * JSON-LD for every page. Two graphs:
 *
 *  - SoftwareApplication + SoftwareSourceCode (multi-typed — the standard
 *    pattern for open-source tools, which makes codeRepository and
 *    programmingLanguage legal properties).
 *  - WebSite, for brand/entity disambiguation.
 *
 * The FAQ graph is not here: it belongs on the one page that shows those
 * questions, and `FaqStructuredData` above is rendered there.
 *
 * softwareVersion is deliberately absent: a hardcoded version goes stale the
 * moment a release ships, and wrong structured data is worse than none.
 *
 * Rendered from a server component, so it ships in the static HTML and is
 * visible to crawlers that do not execute JavaScript.
 */
export function StructuredData() {
  const graph = [
    {
      '@type': ['SoftwareApplication', 'SoftwareSourceCode'],
      '@id': `${SITE_URL}/#software`,
      name: 'Syncle',
      alternateName: 'Syncle database sync',
      description: DESCRIPTION,
      url: SITE_URL,
      sameAs: GITHUB,
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'Database synchronization',
      operatingSystem: 'macOS, Linux, Docker',
      softwareRequirements: 'Docker',
      license: 'https://opensource.org/licenses/MIT',
      isAccessibleForFree: true,
      datePublished: '2026-08-21',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      author: {
        '@type': 'Person',
        name: 'Osman Ahmadzai',
        url: AUTHOR_GITHUB,
      },
      codeRepository: GITHUB,
      programmingLanguage: 'TypeScript',
      downloadUrl: `${GITHUB}/releases/latest`,
      installUrl: `${SITE_URL}/install`,
      screenshot: `${SITE_URL}/opengraph-image`,
      featureList: [
        'Cross-engine database synchronization',
        'Change data capture (CDC) in real time',
        'Cursor-based polling',
        'One-shot backfill and migration',
        'Idempotent upserts keyed by chosen columns',
        'Propagates inserts, updates and deletes',
        'Automatic destination table creation with type translation',
        'Column mapping and renaming',
        'HTTP endpoints as a destination',
        'SSH tunnels to private databases',
      ],
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'Syncle',
      description: DESCRIPTION,
      inLanguage: 'en',
      publisher: { '@type': 'Person', name: 'Osman Ahmadzai', url: AUTHOR_GITHUB },
    },
  ];

  return (
    <script
      type="application/ld+json"
      // the payload is authored here, not user input; stringify keeps it valid
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }),
      }}
    />
  );
}

export { TITLE };
