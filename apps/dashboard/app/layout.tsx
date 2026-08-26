import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://thesisforge-dashboard.davidwallach2.workers.dev'),
  title: 'ThesisForge',
  description: 'Private research desk — preregister, break, learn, deploy.',
  openGraph: {
    title: 'ThesisForge',
    description: 'Preregister. Break. Learn. Deploy.',
    type: 'website',
    images: [{ url: '/og.png', width: 1672, height: 941, alt: 'ThesisForge' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ThesisForge',
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
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Sora:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
