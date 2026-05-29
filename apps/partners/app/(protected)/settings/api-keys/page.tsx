'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useOrg } from '@/lib/org_context';
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
} from '@/lib/api/queries';
import type { ApiKey } from '@/lib/api/types';
import { Badge } from '@/lib/ui/Badge';
import { Button } from '@/lib/ui/Button';
import { Card } from '@/lib/ui/Card';
import { Input } from '@/lib/ui/Input';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function fmtIst(iso: string | null) {
  if (!iso) return '—';
  return IST_FMT.format(new Date(iso));
}

interface NewKey {
  id: string;
  name: string;
  plaintext: string;
}

export default function ApiKeysPage() {
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';

  const { data: keys = [], isLoading, isError } = useApiKeys(tenantId);
  const createMut = useCreateApiKey(tenantId);
  const revokeMut = useRevokeApiKey(tenantId);

  const [name, setName] = useState('');
  const [role, setRole] = useState<'read' | 'write' | 'admin'>('write');
  const [newKey, setNewKey] = useState<NewKey | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const res = await createMut.mutateAsync({ name: name.trim(), role });
    setNewKey({ id: res.id, name: name.trim(), plaintext: res.plaintext });
    setName('');
    setRole('write');
    setCopied(false);
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function handleRevoke(k: ApiKey) {
    const confirmed = window.confirm(
      `Revoke API key "${k.name}" (${k.keyPrefix}…)? This cannot be undone — any integration using it will start receiving 401s immediately.`,
    );
    if (!confirmed) return;
    await revokeMut.mutateAsync(k.id);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Link
          href="/settings"
          className="text-sm text-slate-500 transition-colors hover:text-slate-800"
        >
          &larr; Settings
        </Link>
        <h1 className="text-xl font-semibold text-[#0f172a]">API keys</h1>
      </div>

      {/* One-shot reveal panel — visible until the user navigates away. */}
      {newKey && (
        <Card
          title="Save this key now"
          subtitle="Circls only shows the full key once. After you leave this page it's gone — there is no way to recover it."
          className="border-amber-300 bg-amber-50"
        >
          <div className="flex flex-col gap-3">
            <div className="font-mono break-all rounded border border-amber-300 bg-white p-3 text-sm text-slate-900">
              {newKey.plaintext}
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void copyToClipboard(newKey.plaintext)}
              >
                {copied ? 'Copied' : 'Copy to clipboard'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNewKey(null)}
              >
                I've saved it — dismiss
              </Button>
            </div>
            <p className="text-xs text-amber-800">
              Use header <code className="font-mono">Authorization: Bearer {newKey.plaintext.slice(0, 12)}…</code> for requests against <code>/api/v1/*</code>.
            </p>
          </div>
        </Card>
      )}

      {/* Create form */}
      <Card title="Create a key" subtitle="One key per integration is the recommended model — easier to revoke if it leaks.">
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. PartnerCo aggregator"
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'read' | 'write' | 'admin')}
              className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a]"
            >
              <option value="read">read</option>
              <option value="write">write</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <Button type="submit" loading={createMut.isPending} disabled={!name.trim()}>
            Generate key
          </Button>
        </form>
        {createMut.isError && (
          <p className="mt-3 text-sm text-red-600">
            Failed to create key: {(createMut.error as Error).message}
          </p>
        )}
      </Card>

      {/* List */}
      <Card title="Existing keys" subtitle="Revoked keys are kept for audit history. Plaintext is never recoverable.">
        {isLoading && <p className="py-6 text-center text-sm text-slate-400">Loading&hellip;</p>}
        {isError && (
          <p className="py-6 text-center text-sm text-red-500">Failed to load API keys.</p>
        )}
        {!isLoading && !isError && keys.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">
            No API keys yet. Create one above to start integrating.
          </p>
        )}
        {!isLoading && !isError && keys.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">Name</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Prefix</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Role</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Last used (IST)</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Created (IST)</th>
                  <th className="pb-2 font-medium text-slate-500"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {keys.map((k) => (
                  <tr key={k.id} className="align-middle">
                    <td className="py-2.5 pr-4 text-slate-700">{k.name}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-500">{k.keyPrefix}…</td>
                    <td className="py-2.5 pr-4">
                      <Badge tone="neutral" label={k.role} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge
                        tone={k.status === 'active' ? 'success' : 'warning'}
                        label={k.status}
                      />
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {fmtIst(k.lastUsedAt)}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {fmtIst(k.createdAt)}
                    </td>
                    <td className="py-2.5 text-right">
                      {k.status === 'active' && (
                        <Button
                          variant="danger"
                          size="sm"
                          loading={revokeMut.isPending && revokeMut.variables === k.id}
                          onClick={() => void handleRevoke(k)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
