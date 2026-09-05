import type { Metadata, Viewport } from 'next';

import { isPublicDesk, publicDeskOrigin } from '../lib/desk-mode';
import './globals.css';

const publicOrigin = publicDeskOrigin();

export const metadata: Metadata = {
  metadataBase: new URL(publicOrigin || 'http://localhost:5173'),
  title: 'Quantanamo',
  description: isPublicDesk()
    ? 'Read-only Quantanamo desk. Published snapshot only — the site cannot write the ledger.'
    : 'Local research/trading terminal over the Quantanamo ledger.',
  openGraph: {
    title: 'Quantanamo',
    description: isPublicDesk()
      ? 'Read-only public desk over a published snapshot.'
      : 'Preregister. Break. Learn. Deploy.',
    type: 'website',
    images: [{ url: '/og.png', width: 1672, height: 941, alt: 'Quantanamo' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Quantanamo',
    description: isPublicDesk()
      ? 'Read-only public desk over a published snapshot.'
      : 'Preregister. Break. Learn. Deploy.',
    images: ['/og.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#07080a',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
