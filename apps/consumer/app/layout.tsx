import type { Metadata } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
// TODO(Task 5.1): restore Footer
// import { Footer } from '@/components/Footer';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });

export const metadata: Metadata = {
  title: 'Circls — Find your circle. Book your spot.',
  description: 'Discover and book venues, events and memberships near you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
      <body className="flex min-h-full flex-col">
        <Providers>
          <div className="flex-1">{children}</div>
          {/* TODO(Task 5.1): restore Footer */}
          {/* <Footer /> */}
        </Providers>
      </body>
    </html>
  );
}
