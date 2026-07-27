import type { Metadata } from 'next';
import { Bricolage_Grotesque, Caveat, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

// Brand fonts (see the brand sheet): display, body, handwritten accent.
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['400', '600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});
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
    <html lang="en" className={`${bricolage.variable} ${jakarta.variable} ${caveat.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
