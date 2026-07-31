import Link from 'next/link';
import { BrandMark } from '@/lib/ui';

const LINKS = [
  { href: '/venues', label: 'Venues' },
  { href: '/events', label: 'Events' },
  { href: '/memberships', label: 'Memberships' },
  { href: '/orgs', label: 'Organisations' },
  { href: '/help', label: 'Help' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'Terms & Conditions' },
  { href: '/refund', label: 'Refund Policy' },
];

export function Footer() {
  return (
    <footer className="border-t-[2px] border-ink bg-pastel-peach text-ink">
      {/* Full-bleed like the header — content hugs the page edges. */}
      <div className="px-3 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Lockup per the brand sheet: petals-C, then wide-tracked IRCLS. */}
          <Link href="/" className="flex items-center gap-2 font-display text-base font-extrabold text-ink">
            <BrandMark className="h-7 w-7" />
            <span className="tracking-[0.3em]">IRCLS</span>
          </Link>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="font-semibold text-ink hover:text-coral-deep">{l.label}</Link>
            ))}
            <a href="mailto:contact@gibbous.io" className="font-semibold text-ink hover:text-coral-deep">Contact</a>
          </nav>
        </div>
        <div className="mt-5 border-t border-ink/15 pt-4 text-xs leading-relaxed">
          <p className="text-ink">© 2026 Gibbous.io. All rights reserved.</p>
          <p className="mt-1 text-ink-soft">
            Gibbous Technologies Private Limited · GSTIN 27AALCG2506R1Z3 · Pune, Maharashtra, India · contact@gibbous.io
          </p>
        </div>
      </div>
    </footer>
  );
}
