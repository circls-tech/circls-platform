'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSuperAdminOrgSearch, useSuperAdminVisit } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import { Badge, Input, Modal } from '@/lib/ui';

/**
 * A Circls super admin finds any partner org and opens it: it joins their
 * org switcher (marked Circls) until they leave it or open another. The
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
    <Modal open={open} onClose={onClose} title="Open an organisation" maxWidth="max-w-md">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-500">
          As a Circls super admin you can work in any organisation, as a Manager would, apart from its
          team and API keys. They see your visit and every change you make in their audit log.
        </p>
        <Input
          type="search"
          autoFocus
          placeholder="Search by name or slug"
          aria-label="Search organisations"
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
            <li className="px-2 py-2 text-sm text-slate-500">No organisation matches “{term}”.</li>
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
                    {[org.city, org.slug].filter(Boolean).join(' · ')}
                  </span>
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
