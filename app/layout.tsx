import type { Metadata, Viewport } from 'next';
import { Source_Serif_4 } from 'next/font/google';
import { StructuredData } from '@/components/structured-data';
import { DESCRIPTION, GITHUB, SITE_URL, TITLE } from '@/lib/content';
import './globals.css';

/*
 * One downloaded face, for headings only. Body text is the visitor's own
 * system font — nothing to load, and nothing to flash.
 */
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-heading',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: '%s · Syncle' },
  description: DESCRIPTION,
  applicationName: 'Syncle',
  category: 'technology',
  keywords: [
    'database sync',
    'sync databases',
    'database replication',
    'change data capture',
    'CDC tool',
    'PostgreSQL to MongoDB',
    'MySQL to PostgreSQL',
    'cross-database sync',
    'self-hosted data sync',
    'open source ETL',
    'Airbyte alternative',
    'Debezium alternative',
    'PostgreSQL logical replication',
    'MySQL binlog',
    'MongoDB change streams',
  ],
  authors: [{ name: 'Osman Ahmadzai', url: GITHUB }],
  creator: 'Osman Ahmadzai',
  publisher: 'Syncle',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Syncle',
    title: TITLE,
    description: DESCRIPTION,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
  // SVG first for anything that will take it; the PNG is the fallback for
  // browsers that still will not, and Apple gets an unrounded square because
  // iOS masks the corners itself.
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icon-32.png', type: 'image/png', sizes: '32x32' },
    ],
    apple: [{ url: '/apple-icon.png', type: 'image/png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  colorScheme: 'light',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={sourceSerif.variable}>
      <head>
        <StructuredData />
      </head>
      <body className="font-sans">{children}</body>
    </html>
  );
}
