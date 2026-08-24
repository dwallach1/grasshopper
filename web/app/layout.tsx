import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://thesisforge-dashboard.davidwallach2.workers.dev'),
  title: 'ThesisForge — Ontology / Research Desk',
  description: 'A closed-loop research desk for preregistering, breaking, learning from, and deploying investment theses.',
  openGraph: {
    title: 'ThesisForge — Ontology / Research Desk',
    description: 'Preregister. Break. Learn. Deploy.',
    type: 'website',
    images: [{ url: '/og.png', width: 1672, height: 941, alt: 'ThesisForge ontology research desk' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ThesisForge — Ontology / Research Desk',
    description: 'Preregister. Break. Learn. Deploy.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
