'use client';
import Link from 'next/link';
import { useLocation } from '@/lib/location/LocationProvider';
import { BrandMark } from '@/lib/ui';
import { HelpWidget } from '@/components/HelpWidget';
import { MobileMenu } from '@/components/MobileMenu';
import { ProfileMenu } from '@/components/ProfileMenu';

export function Header() {
  const { city, country, placeLabel, openPicker } = useLocation();
  // Prefer the served city, then the user's actual (reverse-geocoded) city,
  // and only then the bare country.
  const locationLabel = city ?? placeLabel ?? country ?? 'Set location';

  return (
    <header className="sticky top-0 z-40 border-b-[2.5px] border-ink bg-surface/90 backdrop-blur">
      {/* Brand row — logo hugs the left edge; only the mobile hamburger sits opposite. */}
      <div className="flex items-center justify-between px-3 pt-2">
        <Link
          href="/"
          className="flex items-center gap-2 font-display text-2xl font-extrabold tracking-tight text-ink"
        >
          <BrandMark className="h-8 w-8" />
          <span>circls</span>
        </Link>
        {/* Mobile hamburger (sm:hidden internally). */}
        <MobileMenu />
      </div>

      {/* Second row — profile dropdown under the logo; nav hugs the right edge. */}
      <div className="flex items-center justify-between gap-3 px-3 pb-2 pt-1">
        <ProfileMenu />
        <nav className="flex items-center gap-3 sm:gap-5">
          <button
            onClick={openPicker}
            className="flex items-center gap-1 text-sm font-semibold text-ink-soft hover:text-ink"
            aria-label={city || placeLabel || country ? `Location: ${locationLabel}. Change location` : 'Set your location'}
          >
            <span aria-hidden>📍</span>
            <span className="max-w-[7rem] truncate">{locationLabel}</span>
          </button>
          {/* Desktop nav (sm+). On mobile these collapse into the hamburger menu. */}
          <Link href="/venues" className="hidden text-sm font-semibold text-ink-soft hover:text-ink sm:inline">Venues</Link>
          <Link href="/events" className="hidden text-sm font-semibold text-ink-soft hover:text-ink sm:inline">Events</Link>
          <Link href="/memberships" className="hidden text-sm font-semibold text-ink-soft hover:text-ink sm:inline">Memberships</Link>
          {/* Help chatbot entry point — far right of the nav row (#115). */}
          <span className="hidden sm:flex">
            <HelpWidget />
          </span>
        </nav>
      </div>
    </header>
  );
}
