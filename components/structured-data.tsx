import { DESCRIPTION, FAQ, GITHUB, SITE_URL, TITLE } from '@/lib/content';

/**
 * JSON-LD for the page. Three graphs:
 *
 *  - SoftwareApplication, so Google can present Syncle as a piece of software
 *    (name, licence, price, operating systems) rather than a generic page.
 *  - FAQPage, mirroring the visible FAQ exactly — Google requires the answers
 *    to be present on the page, which is why both read from lib/content.
 *  - WebSite, which is what makes a sitelinks search box eligible.
 *
 * Rendered from a server component, so it ships in the static HTML and is
 * visible to crawlers that do not execute JavaScript.
 */
export function StructuredData() {
  const graph = [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#software`,
      name: 'Syncle',
      alternateName: 'Syncle database sync',
      description: DESCRIPTION,
      url: SITE_URL,
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'Database synchronisation',
      operatingSystem: 'macOS, Linux, Docker',
      softwareVersion: '1.2.0',
      license: 'https://opensource.org/licenses/MIT',
      isAccessibleForFree: true,
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      author: {
        '@type': 'Person',
        name: 'Osman Ahmadzai',
      },
      codeRepository: GITHUB,
      programmingLanguage: 'TypeScript',
      featureList: [
        'Cross-engine database synchronisation',
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
      '@type': 'FAQPage',
      '@id': `${SITE_URL}/#faq`,
      mainEntity: FAQ.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'Syncle',
      description: DESCRIPTION,
      inLanguage: 'en',
      publisher: { '@type': 'Person', name: 'Osman Ahmadzai' },
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
