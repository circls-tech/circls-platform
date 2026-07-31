'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMyProfile } from '@/lib/api/consumer';
import { useLocation } from '@/lib/location/LocationProvider';

import { HelpPanel } from '@/components/HelpWidget';

const ITEMS = [
  { href: '/me/bookings', label: 'My bookings', petal: '#FFB0A3', icon: 'calendar' },
  { href: '/me/memberships', label: 'My memberships', petal: '#FCE38A', icon: 'members' },
  { href: '/me/questions', label: 'My questions', petal: '#BCE3A0', icon: 'chat' },
  { href: '/me/profile', label: 'Settings', petal: '#CDBBF7', icon: 'settings' },
] as const;

type ItemIconName = (typeof ITEMS)[number]['icon'] | 'chat-filled' | 'help';

/** Stroke icons matching the partner portal's sidebar set. */
function ItemIcon({ name }: { name: ItemIconName }) {
  const common = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'shrink-0',
  };
  switch (name) {
    case 'calendar':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case 'members':
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'chat':
    case 'chat-filled':
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          {name === 'chat-filled' && <path d="M8 9h8M8 13h5" />}
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case 'help':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
  }
}

/**
 * Account navigation for the consumer web app. Renders the "Profile" chip at
 * the right edge of the header; clicking it slides in a right-side sidebar
 * with the account destinations (colored petal dots, current page
 * highlighted), Chat with us (the #115 help chatbot), Help & support, and
 * Sign out. Signed-out visitors get the Sign in button instead. Closes on
 * Escape, click-outside, and navigation.
 */
export function ProfileSidebar() {
  const { user, loading, signOut } = useAuth();
  const profile = useMyProfile();
  const { city, placeLabel, country } = useLocation();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
      <div className="hidden lg:block">
        {/* Chip built like the location pill so the whole nav row shares one
            size and face. */}
        <Link
          href="/login"
          className="inline-flex items-center rounded-xl border-[2.5px] border-ink bg-coral px-3.5 py-1.5 text-sm font-bold text-ink shadow-offset-sm transition-transform hover:-translate-y-0.5"
        >
          Sign in
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
      <div className="hidden lg:block">
        {/* The avatar itself is the trigger — one element, like the lone C mark. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Open profile menu"
          className="flex h-9 w-9 items-center justify-center rounded-lg border-2 border-ink bg-pastel-pink text-sm font-bold text-ink shadow-offset-sm transition-transform hover:-translate-y-0.5"
        >
          {initial}
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
                className="flex h-10 w-10 items-center justify-center rounded-lg border-2 border-ink bg-pastel-pink text-base font-bold text-ink"
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
                      'group flex items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm font-semibold text-ink',
                      active ? 'bg-surface-2' : 'hover:bg-surface-2',
                    ].join(' ')}
                  >
                    {/* The petal lives on the icon chip; rows stay quiet. */}
                    <span
                      aria-hidden
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-[1.5px] border-ink transition-transform group-hover:-translate-y-0.5"
                      style={{ backgroundColor: item.petal }}
                    >
                      <ItemIcon name={item.icon} />
                    </span>
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="mx-4 border-t border-ink/15" />
            <div className="flex flex-col gap-1 px-3 pb-5 pt-3">
              {/* Help chatbot entry point (#115) — opens the guided-flow panel. */}
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => {
                  setOpen(false);
                  setHelpOpen(true);
                }}
                className="flex items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-surface-2"
              >
                <ItemIcon name="chat-filled" />
                Chat with us
              </button>
              <Link
                href="/help"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm font-semibold text-ink hover:bg-surface-2"
              >
                <ItemIcon name="help" />
                Help &amp; support
              </Link>
              <button
                type="button"
                onClick={async () => {
                  setOpen(false);
                  await signOut();
                  router.replace('/');
                }}
                className="mt-1 flex items-center justify-center gap-2 rounded-xl border-2 border-ink bg-pastel-salmon px-3 py-2 text-sm font-bold text-ink shadow-[2px_2px_0_#17151D] transition-transform hover:-translate-y-0.5"
              >
                {/* Standard log-out glyph: door bracket + outward arrow. */}
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Sign out
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Sibling of the sidebar portal so it stays mounted (and open) after
          the sidebar itself closes. */}
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
