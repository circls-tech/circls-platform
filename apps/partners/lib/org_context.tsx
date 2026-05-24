'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useMyTenants } from '@/lib/api/queries';
import type { Tenant } from '@/lib/api/types';

const STORAGE_KEY = 'circls.activeTenantId';

interface OrgContextValue {
  activeTenantId: string | null;
  setActiveTenantId: (id: string) => void;
  tenants: Tenant[];
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const { data: tenants = [] } = useMyTenants();

  const [activeTenantId, setActiveTenantIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY) ?? null;
  });

  // Once tenants load:
  //  1. Default to the first tenant when no persisted choice exists.
  //  2. Reconcile a stale localStorage id that no longer belongs to this user
  //     (e.g. the tenant was removed) — reset to the first available tenant so
  //     they are never stranded on 403 / empty venue lists.
  useEffect(() => {
    if (tenants.length === 0) return;
    const tenantIds = tenants.map((t) => t.id);
    if (!activeTenantId || !tenantIds.includes(activeTenantId)) {
      const firstId = tenants[0].id;
      setActiveTenantIdState(firstId);
      localStorage.setItem(STORAGE_KEY, firstId);
    }
  }, [tenants, activeTenantId]);

  function setActiveTenantId(id: string) {
    setActiveTenantIdState(id);
    localStorage.setItem(STORAGE_KEY, id);
  }

  const value = useMemo<OrgContextValue>(
    () => ({ activeTenantId, setActiveTenantId, tenants }),
    [activeTenantId, tenants],
  );

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within <OrgProvider>');
  return ctx;
}
