import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Circls Partner Portal',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
        {/* invisible reCAPTCHA target for Firebase phone auth */}
        <div id="recaptcha-container" />
      </body>
    </html>
  );
}
