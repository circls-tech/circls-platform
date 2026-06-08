'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { CheckoutModal } from './CheckoutModal';
import type { CheckoutItem, CheckoutPrefill } from './types';

interface CheckoutContextValue {
  openCheckout: (item: CheckoutItem, prefill?: CheckoutPrefill) => void;
}
const CheckoutContext = createContext<CheckoutContextValue | null>(null);

export function useCheckoutModal(): CheckoutContextValue {
  const ctx = useContext(CheckoutContext);
  if (!ctx) throw new Error('useCheckoutModal must be used within <CheckoutProvider>');
  return ctx;
}

export function CheckoutProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState<{ item: CheckoutItem; prefill: CheckoutPrefill } | null>(null);

  const openCheckout = useCallback((item: CheckoutItem, prefill: CheckoutPrefill = {}) => {
    if (!user) { router.push(`/login?redirect=${encodeURIComponent(pathname ?? '/')}`); return; }
    setOpen({ item, prefill });
  }, [user, router, pathname]);

  return (
    <CheckoutContext.Provider value={{ openCheckout }}>
      {children}
      {open && <CheckoutModal item={open.item} prefill={open.prefill} onClose={() => setOpen(null)} />}
    </CheckoutContext.Provider>
  );
}
