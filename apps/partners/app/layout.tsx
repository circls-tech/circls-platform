import type { Metadata } from 'next';
import { Caveat } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

// Handwritten accent for section labels — same accent family the consumer app uses.
const caveat = Caveat({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-accent',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'circls Partner Portal',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={caveat.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
