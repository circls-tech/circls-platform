'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMyProfile } from '@/lib/api/consumer';
import { useLocation } from '@/lib/location/LocationProvider';
import { Button } from '@/lib/ui';

const ITEMS: { href: string; label: string; dot: string }[] = [
  { href: '/me/bookings', label: 'My bookings', dot: 'var(--color-pastel-salmon)' },
  { href: '/me/memberships', label: 'My memberships', dot: 'var(--color-pastel-butter)' },
  { href: '/me/questions', label: 'My questions', dot: 'var(--color-pastel-lime)' },
  { href: '/me/profile', label: 'Settings', dot: 'var(--color-pastel-lilac)' },
];

/**
 * Account navigation for the consumer web app. Renders the "Profile" chip at
 * the right edge of the header; clicking it slides in a right-side sidebar
 * with the account destinations (colored petal dots, current page
 * highlighted), Help & support, and Sign out. Signed-out visitors get the
 * Sign in button instead. Closes on Escape, click-outside, and navigation.
 */
export function ProfileSidebar() {
  const { user, loading, signOut } = useAuth();
  const profile = useMyProfile();
  const { city, placeLabel, country } = useLocation();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  // Sidebar top offset — the sticky header's height, so the panel slides in
  // under the header rule (per the design mock) instead of covering the brand.
  const [topOffset, setTopOffset] = useState(0);

  // Portal target is only available in the browser.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    function measure() {
      setTopOffset(document.querySelector('header')?.getBoundingClientRect().bottom ?? 0);
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  // Escape-to-close + lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (loading) return null;

  if (!user) {
    return (
      <div className="hidden sm:block">
        <Link href="/login">
          <Button variant="primary" size="sm">Sign in</Button>
        </Link>
      </div>
    );
  }

  const name = profile.data?.displayName ?? null;
  const initial = (name ?? 'You').charAt(0).toUpperCase();
  const place = city ?? placeLabel ?? country ?? null;
  const subtitle = [name, place].filter(Boolean).join(' · ');

  return (
    <>
      {/* Collapsed chip — right edge of the header row. Mobile gets the
          account links via the hamburger instead. */}
      <div className="hidden sm:block">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="flex items-center gap-2.5 rounded-full border-[2.5px] border-ink bg-white py-1.5 pl-1.5 pr-4 shadow-offset-sm"
        >
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-full border-[2.5px] border-ink bg-lav font-display text-sm font-extrabold text-ink"
          >
            {initial}
          </span>
          <span className="text-sm font-bold text-ink">Profile</span>
        </button>
      </div>

      {open && mounted && createPortal(
        <div
          className="fixed inset-x-0 bottom-0 z-50"
          style={{ top: topOffset }}
          role="dialog"
          aria-modal="true"
          aria-label="Profile"
        >
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-0 flex h-full w-full max-w-xs flex-col border-l-[2.5px] border-ink bg-surface-card">
            {/* Profile header — avatar, title, "name · city". */}
            <div className="flex items-center gap-3 px-4 pb-4 pt-5">
              <span
                aria-hidden
                className="flex h-11 w-11 items-center justify-center rounded-full border-[2.5px] border-ink bg-lav font-display text-lg font-extrabold text-ink"
              >
                {initial}
              </span>
              <div className="min-w-0">
                <p className="font-display text-xl font-extrabold leading-tight text-ink">Profile</p>
                {subtitle ? (
                  <p className="truncate text-sm font-semibold text-ink-soft">{subtitle}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close profile menu"
                className="ml-auto text-xl font-bold leading-none text-ink-soft hover:text-ink"
              >
                ✕
              </button>
            </div>

            <nav className="flex flex-1 flex-col gap-2 overflow-y-auto px-3">
              {ITEMS.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'flex items-center gap-3 px-3 py-2.5 text-base font-bold text-ink',
                      active
                        ? 'rounded-[var(--radius)] border-[2.5px] border-ink bg-coral-soft shadow-offset-sm'
                        : 'rounded-[var(--radius)] hover:bg-surface-2',
                    ].join(' ')}
                  >
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 rounded-full border border-ink/40"
                      style={{ backgroundColor: item.dot }}
                    />
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="mx-4 border-t border-ink/15" />
            <div className="flex flex-col gap-1 px-3 pb-5 pt-3">
              <Link
                href="/help"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-[var(--radius)] px-3 py-2.5 text-base font-bold text-ink hover:bg-surface-2"
              >
                <span
                  aria-hidden
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-sm font-bold text-white"
                >
                  ?
                </span>
                Help &amp; support
              </Link>
              <button
                type="button"
                onClick={async () => {
                  setOpen(false);
                  await signOut();
                  router.replace('/');
                }}
                className="rounded-[var(--radius)] px-3 py-2.5 text-left text-base font-semibold text-ink-soft hover:bg-surface-2 hover:text-ink"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
