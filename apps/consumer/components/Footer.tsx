import Link from 'next/link';
import { BrandMark } from '@/lib/ui';

const LINKS = [
  { href: '/venues', label: 'Venues' },
  { href: '/events', label: 'Events' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'Terms & Conditions' },
  { href: '/refund', label: 'Refund Policy' },
];

export function Footer() {
  return (
    <footer className="bg-ink-deep text-white/70">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 font-display text-xl text-white">
            <BrandMark className="h-7 w-7" />
            <span>circls</span>
          </Link>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="text-white/80 hover:text-white">{l.label}</Link>
            ))}
            <a href="mailto:contact@gibbous.io" className="text-white/80 hover:text-white">Contact</a>
          </nav>
        </div>
        <div className="mt-5 border-t border-white/10 pt-4 text-xs leading-relaxed">
          <p className="text-white/80">© 2026 Gibbous.io. All rights reserved.</p>
          <p className="mt-1">
            Gibbous Technologies Private Limited · GSTIN 27AALCG2506R1Z3 · Pune, Maharashtra, India · contact@gibbous.io
          </p>
        </div>
      </div>
    </footer>
  );
}
