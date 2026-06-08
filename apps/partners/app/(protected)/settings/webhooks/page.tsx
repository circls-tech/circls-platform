'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import {
  useCreateWebhookSubscription,
  useDeleteWebhookSubscription,
  useWebhookSubscriptions,
} from '@/lib/api/queries';
import type { WebhookSubscription } from '@/lib/api/types';
import { Badge } from '@/lib/ui/Badge';
import { Button } from '@/lib/ui/Button';
import { Card } from '@/lib/ui/Card';
import { Input } from '@/lib/ui/Input';

const AVAILABLE_EVENTS = [
  'booking.confirmed',
  'booking.cancelled',
  'payment.captured',
  'payment.refunded',
];

interface NewSubscription {
  id: string;
  url: string;
  secret: string;
}

export default function WebhooksPage() {
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { resolveTz } = useTimezone();
  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: resolveTz(),
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    [resolveTz],
  );

  const { data: subs = [], isLoading, isError } = useWebhookSubscriptions(tenantId);
  const createMut = useCreateWebhookSubscription(tenantId);
  const deleteMut = useDeleteWebhookSubscription(tenantId);

  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['booking.confirmed']);
  const [newSub, setNewSub] = useState<NewSubscription | null>(null);
  const [copied, setCopied] = useState(false);

  function toggleEvent(ev: string) {
    setEvents((prev) =>
      prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev],
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || events.length === 0) return;
    const res = await createMut.mutateAsync({ url: url.trim(), events });
    setNewSub({ id: res.id, url: url.trim(), secret: res.secret });
    setUrl('');
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

  async function handleDelete(s: WebhookSubscription) {
    const confirmed = window.confirm(
      `Delete webhook to ${s.url}? Pending deliveries will be discarded.`,
    );
    if (!confirmed) return;
    await deleteMut.mutateAsync(s.id);
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
        <h1 className="text-xl font-semibold text-[#0f172a]">Outbound webhooks</h1>
      </div>

      {newSub && (
        <Card
          title="Save this signing secret now"
          subtitle="Use it to verify the X-Circls-Signature header on incoming deliveries. Shown only once."
          className="border-amber-300 bg-amber-50"
        >
          <div className="flex flex-col gap-3">
            <div className="font-mono break-all rounded border border-amber-300 bg-white p-3 text-sm text-slate-900">
              {newSub.secret}
            </div>
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void copyToClipboard(newSub.secret)}
              >
                {copied ? 'Copied' : 'Copy to clipboard'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNewSub(null)}
              >
                I've saved it — dismiss
              </Button>
            </div>
            <p className="text-xs text-amber-800">
              Verify with HMAC-SHA256 over <code className="font-mono">`${'{t}'}.${'{rawBody}'}`</code> — header has form <code className="font-mono">t=&lt;ts&gt;,v1=&lt;hex&gt;</code>.
            </p>
          </div>
        </Card>
      )}

      <Card title="Create a subscription">
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <Input
            label="Delivery URL"
            type="url"
            placeholder="https://example.com/webhooks/circls"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Events
            </label>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_EVENTS.map((ev) => {
                const active = events.includes(ev);
                return (
                  <button
                    key={ev}
                    type="button"
                    onClick={() => toggleEvent(ev)}
                    className={[
                      'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                      active
                        ? 'bg-brand-600 text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                    ].join(' ')}
                  >
                    {ev}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <Button
              type="submit"
              loading={createMut.isPending}
              disabled={!url.trim() || events.length === 0}
            >
              Create subscription
            </Button>
          </div>
          {createMut.isError && (
            <p className="text-sm text-red-600">
              Failed to create subscription: {(createMut.error as Error).message}
            </p>
          )}
        </form>
      </Card>

      <Card title="Active subscriptions">
        {isLoading && <p className="py-6 text-center text-sm text-slate-400">Loading&hellip;</p>}
        {isError && (
          <p className="py-6 text-center text-sm text-red-500">
            Failed to load webhook subscriptions.
          </p>
        )}
        {!isLoading && !isError && subs.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">No webhook subscriptions yet.</p>
        )}
        {!isLoading && !isError && subs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">URL</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Events</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Created</th>
                  <th className="pb-2 font-medium text-slate-500"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {subs.map((s) => (
                  <tr key={s.id} className="align-middle">
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-700 break-all">
                      {s.url}
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {s.events.map((ev) => (
                          <Badge key={ev} tone="neutral" label={ev} />
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge
                        tone={s.status === 'active' ? 'success' : 'warning'}
                        label={s.status}
                      />
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {fmt.format(new Date(s.createdAt))}
                    </td>
                    <td className="py-2.5 text-right">
                      <div className="flex justify-end gap-2">
                        <Link
                          href={`/settings/webhooks/${s.id}/deliveries`}
                          className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          Deliveries
                        </Link>
                        <Button
                          variant="danger"
                          size="sm"
                          loading={deleteMut.isPending && deleteMut.variables === s.id}
                          onClick={() => void handleDelete(s)}
                        >
                          Delete
                        </Button>
                      </div>
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
