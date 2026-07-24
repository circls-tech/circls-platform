'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button } from '@/lib/ui';

const MENU_ITEMS: { href: string; label: string }[] = [
  { href: '/me/bookings', label: 'My bookings' },
  { href: '/me/memberships', label: 'My memberships' },
  { href: '/me/questions', label: 'My questions' },
  { href: '/me/profile', label: 'Settings' },
  { href: '/help', label: 'Help & support' },
];

/**
 * Account dropdown shown under the brand row of the header. Collects the
 * signed-in account destinations (bookings, memberships, questions, settings,
 * help) plus sign-out, which used to live loose in the header bar. Signed-out
 * visitors get the sign-in button instead. Closes on Escape, click-outside,
 * and navigation.
 */
export function ProfileMenu() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  if (loading) return null;
  if (!user) {
    return (
      <Link href="/login">
        <Button variant="primary" size="sm">Sign in</Button>
      </Link>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-[var(--radius)] border-[2.5px] border-ink bg-white px-3 py-1.5 text-sm font-semibold text-ink shadow-offset-sm"
      >
        <span>Profile</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden
          className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
        >
          <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Profile"
          className="absolute left-0 top-full z-50 mt-2 w-52 rounded-[var(--radius)] border-[2.5px] border-ink bg-surface p-1.5 shadow-offset"
        >
          {MENU_ITEMS.map((item) => (
            <Link
              key={item.href}
              role="menuitem"
              href={item.href}
              onClick={() => setOpen(false)}
              className="block rounded-[var(--radius)] px-2.5 py-2 text-sm font-semibold text-ink hover:bg-surface-2"
            >
              {item.label}
            </Link>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await signOut();
              router.replace('/');
            }}
            className="mt-1 block w-full rounded-[var(--radius)] border-t-[2.5px] border-dashed border-ink/20 px-2.5 pb-2 pt-2.5 text-left text-sm font-semibold text-ink-soft hover:bg-surface-2 hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
