import type { Metadata } from 'next';
import { Bricolage_Grotesque, Plus_Jakarta_Sans, Caveat } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { Footer } from '@/components/Footer';

// Brand fonts — display, body, handwritten accent.
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['400', '600', '700', '800'],
  variable: '--font-bricolage',
  display: 'swap',
});
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-jakarta',
  display: 'swap',
});
const caveat = Caveat({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-caveat',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'circls — Find your circle. Book your spot.',
  description: 'Discover and book venues, events and memberships near you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${jakarta.variable} ${caveat.variable}`}>
      <body className="flex min-h-full flex-col">
        <Providers>
          <div className="flex-1">{children}</div>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
