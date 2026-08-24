import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/content';

// emitted as a static /sitemap.xml at build time
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date('2026-08-24'),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
