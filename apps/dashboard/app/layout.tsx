import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://thesisforge-dashboard.davidwallach2.workers.dev'),
  title: 'ThesisForge — Research Desk',
  description: 'A closed-loop research desk for preregistering, breaking, learning from, and deploying investment theses.',
  openGraph: {
    title: 'ThesisForge — Research Desk',
    description: 'Preregister. Break. Learn. Deploy.',
    type: 'website',
    images: [{ url: '/og.png', width: 1672, height: 941, alt: 'ThesisForge ontology research desk' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ThesisForge — Research Desk',
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
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Fraunces:opsz,wght@9..144,500;9..144,650;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
