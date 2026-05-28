'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useCreateMembership, useMemberships } from '@/lib/api/memberships';
import { Badge, Button, Card, Input } from '@/lib/ui';

export default function MembershipsPage() {
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { data: memberships, isLoading } = useMemberships(tenantId);
  const createMembership = useCreateMembership(tenantId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priceRupees, setPriceRupees] = useState('0');
  const [durationDays, setDurationDays] = useState('30');
  const [err, setErr] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await createMembership.mutateAsync({
        name,
        ...(description ? { description } : {}),
        pricePaise: Math.round(parseFloat(priceRupees || '0') * 100),
        durationDays: parseInt(durationDays || '30', 10),
      });
      setName('');
      setDescription('');
      setPriceRupees('0');
      setDurationDays('30');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:text-slate-800 transition-colors"
        >
          &larr; Settings
        </Link>
        <h1 className="text-xl font-semibold text-[#0f172a]">Memberships</h1>
      </div>

      <Card title="Plans" subtitle="Time-bound passes your customers can buy. Free plans skip KYC.">
        {isLoading && <p className="py-6 text-center text-sm text-slate-400">Loading…</p>}
        {!isLoading && memberships?.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">
            No memberships yet. Create one below.
          </p>
        )}
        {!isLoading && memberships && memberships.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">Name</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Price</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Duration</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                  <th className="pb-2 font-medium text-slate-500">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {memberships.map((m) => (
                  <tr key={m.id} className="align-top">
                    <td className="py-2.5 pr-4 text-slate-700 font-medium">{m.name}</td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {m.pricePaise === 0 ? (
                        <span className="text-emerald-600">Free</span>
                      ) : (
                        `₹${(m.pricePaise / 100).toFixed(2)}`
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">{m.durationDays}d</td>
                    <td className="py-2.5 pr-4">
                      <Badge
                        tone={m.status === 'active' ? 'success' : 'neutral'}
                        label={m.status}
                      />
                    </td>
                    <td className="py-2.5 text-xs text-slate-500">
                      {m.description ?? <span className="text-slate-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Create a plan">
        <form onSubmit={onCreate} className="flex max-w-lg flex-col gap-3">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Monthly Unlimited"
          />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Optional benefits, perks, etc."
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Price (₹)"
              type="number"
              min={0}
              step="0.01"
              value={priceRupees}
              onChange={(e) => setPriceRupees(e.target.value)}
              hint="0 = free (no KYC needed to purchase)."
            />
            <Input
              label="Duration (days)"
              type="number"
              min={1}
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
              required
            />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end">
            <Button type="submit" loading={createMembership.isPending} disabled={!tenantId}>
              Add membership
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
