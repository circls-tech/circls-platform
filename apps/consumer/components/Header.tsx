'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { useLocation } from '@/lib/location/LocationProvider';
import { Button, BrandMark } from '@/lib/ui';
import { HelpWidget } from '@/components/HelpWidget';

export function Header() {
  const { user, loading, signOut } = useAuth();
  const { city, country, openPicker } = useLocation();
  const router = useRouter();
  const locationLabel = city ?? country ?? 'Set location';

  return (
    <header className="sticky top-0 z-40 border-b-[2.5px] border-ink bg-surface/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link
          href="/"
          className="flex items-center gap-2 font-display text-2xl font-extrabold tracking-tight text-ink"
        >
          <BrandMark className="h-8 w-8" />
          <span>circls</span>
        </Link>
        <nav className="flex items-center gap-3 sm:gap-5">
          <button
            onClick={openPicker}
            className="flex items-center gap-1 text-sm font-semibold text-ink-soft hover:text-ink"
            aria-label={city || country ? `Location: ${locationLabel}. Change location` : 'Set your location'}
          >
            <span aria-hidden>📍</span>
            <span className="max-w-[7rem] truncate">{locationLabel}</span>
          </button>
          <Link href="/venues" className="hidden text-sm font-semibold text-ink-soft hover:text-ink sm:inline">Venues</Link>
          <Link href="/events" className="hidden text-sm font-semibold text-ink-soft hover:text-ink sm:inline">Events</Link>
          <Link href="/memberships" className="hidden text-sm font-semibold text-ink-soft hover:text-ink sm:inline">Memberships</Link>
          {loading ? null : user ? (
            <>
              <Link href="/me/bookings" className="text-sm font-semibold text-ink-soft hover:text-ink">My bookings</Link>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => { await signOut(); router.replace('/'); }}
              >
                Sign out
              </Button>
              {/* Help entry point — top-right of Sign out (#115). */}
              <HelpWidget />
            </>
          ) : (
            <>
              <Link href="/login"><Button variant="primary" size="sm">Sign in</Button></Link>
              {/* Help entry point — top-right of Sign in in the signed-out branch (#115). */}
              <HelpWidget />
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
