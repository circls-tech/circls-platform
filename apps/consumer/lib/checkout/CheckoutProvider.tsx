'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { CheckoutModal } from './CheckoutModal';
import { savePendingCheckout, takePendingCheckout } from './pending';
import type { CheckoutItem, CheckoutPrefill } from './types';

/** Optional hooks fired by the modal — e.g. a cart clearing itself on success. */
export interface CheckoutOptions {
  /** Called once the booking is created (paid, reserved, or free-confirmed). */
  onSuccess?: () => void;
}

interface CheckoutContextValue {
  openCheckout: (item: CheckoutItem, prefill?: CheckoutPrefill, opts?: CheckoutOptions) => void;
}
const CheckoutContext = createContext<CheckoutContextValue | null>(null);

export function useCheckoutModal(): CheckoutContextValue {
  const ctx = useContext(CheckoutContext);
  if (!ctx) throw new Error('useCheckoutModal must be used within <CheckoutProvider>');
  return ctx;
}

/**
 * Reopens a checkout that sign-in interrupted, once the visitor lands back on
 * the page that started it.
 *
 * The page resumes rather than the provider, because the page owns the pieces
 * that can't be serialised into storage — chiefly the onSuccess callback its
 * cart uses to clear itself. Handing the stored item back to the page lets it
 * call openCheckout with those wired up exactly as they were.
 */
export function useResumeCheckout(
  onResume: (item: CheckoutItem, prefill: CheckoutPrefill) => void,
): void {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  // Keep the latest callback without making it an effect dependency; pages
  // rebuild it every render and we only ever want to resume once.
  const handler = useRef(onResume);
  handler.current = onResume;
  const resumed = useRef(false);

  useEffect(() => {
    if (loading || !user || !pathname || resumed.current) return;
    const pending = takePendingCheckout(pathname);
    if (!pending) return;
    resumed.current = true;
    handler.current(pending.item, pending.prefill);
  }, [loading, user, pathname]);
}

export function CheckoutProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState<{ item: CheckoutItem; prefill: CheckoutPrefill; onSuccess?: () => void } | null>(null);

  const openCheckout = useCallback((item: CheckoutItem, prefill: CheckoutPrefill = {}, opts: CheckoutOptions = {}) => {
    if (!user) {
      // Stash what they were buying before the redirect unmounts the page, so
      // signing in resumes the purchase instead of dropping them on a blank one.
      const path = pathname ?? '/';
      savePendingCheckout({ path, item, prefill });
      router.push(`/login?redirect=${encodeURIComponent(path)}`);
      return;
    }
    setOpen({ item, prefill, ...(opts.onSuccess ? { onSuccess: opts.onSuccess } : {}) });
  }, [user, router, pathname]);

  return (
    <CheckoutContext.Provider value={{ openCheckout }}>
      {children}
      {open && (
        <CheckoutModal
          item={open.item}
          prefill={open.prefill}
          {...(open.onSuccess ? { onSuccess: open.onSuccess } : {})}
          onClose={() => setOpen(null)}
        />
      )}
    </CheckoutContext.Provider>
  );
}
