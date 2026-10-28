'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSuperAdminOrgSearch, useSuperAdminVisit } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import { Badge, Input, Modal } from '@/lib/ui';
import { useClockTime } from './CirclsHelp';

/**
 * A Circls super admin opens a partner org that has asked for help (let
 * Circls in from "Get help from Circls"): it joins their org switcher (marked
 * Circls) until they leave it, open another, or the org's access ends. The
 * visit, and every change they make there, shows in the org's audit log.
 */
export function SuperAdminOrgPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { tenants, setActiveTenantId } = useOrg();
  const { open: openOrg } = useSuperAdminVisit();
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useSuperAdminOrgSearch(term, open);
  const clock = useClockTime();

  function go(id: string) {
    setActiveTenantId(id);
    onClose();
    router.push('/dashboard');
  }

  async function handlePick(id: string) {
    setError(null);
    // One of your own orgs (or the one already open): just switch to it.
    if (tenants.some((t) => t.id === id)) {
      go(id);
      return;
    }
    try {
      await openOrg.mutateAsync(id);
      go(id);
    } catch (err) {
      setError((err as Error).message || 'Could not open this organisation.');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Organisations asking for help" maxWidth="max-w-md">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-500">
          These organisations have let Circls into their portal. You can work there as a Manager would, apart
          from their team, API keys, Earnings and settings, until their access ends. They see your visit and
          every change you make in their audit log.
        </p>
        <Input
          type="search"
          autoFocus
          placeholder="Filter by name or slug"
          aria-label="Filter organisations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {search.isPending && <li className="px-2 py-2 text-sm text-slate-400">Searching…</li>}
          {search.isError && (
            <li className="px-2 py-2 text-sm text-red-600">{(search.error as Error).message}</li>
          )}
          {search.data?.length === 0 && (
            <li className="px-2 py-2 text-sm text-slate-500">
              {term
                ? `No organisation asking for help matches “${term}”.`
                : 'No organisation is asking for help right now.'}
            </li>
          )}
          {search.data?.map((org) => (
            <li key={org.id}>
              <button
                type="button"
                onClick={() => void handlePick(org.id)}
                disabled={openOrg.isPending}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-60"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold text-slate-900">{org.name}</span>
                  <span className="truncate text-xs text-slate-500">
                    {[org.city, org.slug, `until ${clock(org.expiresAt)}`].filter(Boolean).join(' · ')}
                  </span>
                  {org.note && <span className="line-clamp-2 text-xs text-slate-600">“{org.note}”</span>}
                </span>
                {org.status === 'suspended' && <Badge tone="warning" label="Suspended" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
