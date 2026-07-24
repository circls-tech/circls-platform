'use client';
import Link from 'next/link';
import { useLocation } from '@/lib/location/LocationProvider';
import { BrandMark } from '@/lib/ui';
import { MobileMenu } from '@/components/MobileMenu';
import { ProfileSidebar } from '@/components/ProfileSidebar';

export function Header() {
  const { city, country, placeLabel, openPicker } = useLocation();
  // Prefer the served city, then the user's actual (reverse-geocoded) city,
  // and only then the bare country.
  const locationLabel = city ?? placeLabel ?? country ?? 'Set location';

  return (
    <header className="sticky top-0 z-40 border-b-[2.5px] border-ink bg-surface/90 backdrop-blur">
      <div className="flex items-center justify-between px-3 py-3">
        {/* Wordmark — the petal C-mark is the "c", the text completes "ircls". */}
        <Link
          href="/"
          className="flex items-center gap-1 font-display text-2xl font-extrabold tracking-tight text-ink"
        >
          <BrandMark className="h-9 w-9" />
          <span>ircls</span>
        </Link>

        <nav className="flex items-center gap-3 sm:gap-6">
          <button
            onClick={openPicker}
            className="flex items-center gap-1.5 rounded-full border-[2.5px] border-ink bg-white px-3.5 py-1.5 text-sm font-bold text-ink shadow-offset-sm"
            aria-label={city || placeLabel || country ? `Location: ${locationLabel}. Change location` : 'Set your location'}
          >
            <span aria-hidden>📍</span>
            <span className="max-w-[7rem] truncate">{locationLabel}</span>
          </button>
          {/* Desktop nav (sm+). On mobile these collapse into the hamburger menu. */}
          <Link href="/venues" className="hidden text-base font-bold text-ink hover:text-coral-deep sm:inline">Venues</Link>
          <Link href="/events" className="hidden text-base font-bold text-ink hover:text-coral-deep sm:inline">Events</Link>
          <Link href="/memberships" className="hidden text-base font-bold text-ink hover:text-coral-deep sm:inline">Memberships</Link>
          <Link href="/orgs" className="hidden text-base font-bold text-ink hover:text-coral-deep sm:inline">Organisations</Link>
          {/* Profile chip at the right edge → opens the account sidebar (right side). */}
          <ProfileSidebar />
          {/* Mobile hamburger (sm:hidden internally). */}
          <MobileMenu />
        </nav>
      </div>
    </header>
  );
}
