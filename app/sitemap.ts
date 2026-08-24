import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/content';

// emitted as a static /sitemap.xml at build time
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      // the build date: honest for a static site rebuilt on content change
      lastModified: new Date(),
    },
  ];
}
