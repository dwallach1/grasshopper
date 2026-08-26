import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:5173'),
  title: 'Quantanamo',
  description: 'Local research/trading terminal over the Quantanamo ledger.',
  openGraph: {
    title: 'Quantanamo',
    description: 'Preregister. Break. Learn. Deploy.',
    type: 'website',
    images: [{ url: '/og.png', width: 1672, height: 941, alt: 'Quantanamo' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Quantanamo',
    description: 'Preregister. Break. Learn. Deploy.',
    images: ['/og.png'],
  },
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
