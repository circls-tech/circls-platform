'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { useLocation } from '@/lib/location/LocationProvider';
import { Button } from '@/lib/ui';

const NAV_LINKS: { href: string; label: string }[] = [
  { href: '/venues', label: 'Venues' },
  { href: '/events', label: 'Events' },
  { href: '/memberships', label: 'Memberships' },
  { href: '/help', label: 'Help' },
];

/**
 * Mobile-only navigation (#consumer-ux). A hamburger button visible below `sm`
 * that opens a right-side sheet with the primary nav, the location picker, and
 * the auth actions — which on mobile are moved out of the header bar so it stays
 * single-line. Closes on Escape, on click-outside, and on navigation.
 */
export function MobileMenu() {
  const { user, loading, signOut } = useAuth();
  const { city, country, openPicker } = useLocation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const locationLabel = city ?? country ?? 'Set location';

  // Portal target is only available in the browser.
  useEffect(() => setMounted(true), []);

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

  // Return focus to the trigger when the sheet closes.
  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div className="sm:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Open menu"
        className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] border-[2.5px] border-ink bg-white text-ink shadow-offset-sm"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
          <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>

      {open && mounted && createPortal(
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-ink/40" onClick={close} />
          <div
            ref={panelRef}
            className="absolute right-0 top-0 flex h-full w-full max-w-xs flex-col border-l-[2.5px] border-ink bg-surface shadow-offset"
          >
            <div className="flex items-center justify-between border-b-[2.5px] border-ink px-4 py-3">
              <span className="font-display text-lg font-extrabold text-ink">Menu</span>
              <button
                type="button"
                onClick={close}
                aria-label="Close menu"
                className="text-xl font-bold leading-none text-ink-soft hover:text-ink"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-4 py-4">
              <button
                type="button"
                onClick={() => {
                  close();
                  openPicker();
                }}
                className="flex items-center gap-2 rounded-[var(--radius)] px-2 py-2 text-left text-base font-semibold text-ink hover:bg-surface-2"
              >
                <span aria-hidden>📍</span>
                <span className="truncate">{locationLabel}</span>
              </button>

              {NAV_LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="rounded-[var(--radius)] px-2 py-2 text-base font-semibold text-ink hover:bg-surface-2"
                >
                  {l.label}
                </Link>
              ))}

              <div className="mt-2 border-t-[2.5px] border-dashed border-ink/20 pt-3">
                {loading ? null : user ? (
                  <div className="flex flex-col gap-2">
                    <Link href="/me/bookings" onClick={() => setOpen(false)}>
                      <Button variant="secondary" size="md" className="w-full">My bookings</Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="md"
                      className="w-full"
                      onClick={async () => {
                        setOpen(false);
                        await signOut();
                        router.replace('/');
                      }}
                    >
                      Sign out
                    </Button>
                  </div>
                ) : (
                  <Link href="/login" onClick={() => setOpen(false)}>
                    <Button variant="primary" size="md" className="w-full">Sign in</Button>
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
