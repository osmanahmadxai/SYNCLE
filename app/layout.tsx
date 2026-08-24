import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { StructuredData } from '@/components/structured-data';
import { THEME_SCRIPT } from '@/components/theme-toggle';
import { DESCRIPTION, GITHUB, SITE_URL, TITLE } from '@/lib/content';
import './globals.css';

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
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
  // one page, so the canonical is unambiguous — this kills any duplicate
  // indexing of ?utm_… and trailing-slash variants
  alternates: { canonical: '/' },
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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
  colorScheme: 'light dark',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // the `dark` class is applied by THEME_SCRIPT before first paint, so the
  // element differs from the server markup — hence suppressHydrationWarning
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <StructuredData />
      </head>
      <body className="font-sans">{children}</body>
    </html>
  );
}
