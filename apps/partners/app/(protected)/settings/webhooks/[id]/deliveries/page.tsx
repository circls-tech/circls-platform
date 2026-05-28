'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useWebhookDeliveries } from '@/lib/api/queries';
import type { WebhookDeliveryItem } from '@/lib/api/types';
import { Badge } from '@/lib/ui/Badge';
import { Button } from '@/lib/ui/Button';
import { Card } from '@/lib/ui/Card';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function fmt(iso: string | null) {
  if (!iso) return '—';
  return IST_FMT.format(new Date(iso));
}

function statusTone(s: WebhookDeliveryItem['status']) {
  switch (s) {
    case 'delivered': return 'success' as const;
    case 'failed':    return 'warning' as const;
    case 'expired':   return 'warning' as const;
    case 'pending':   return 'open' as const;
  }
}

function ErrorToggle({ message }: { message: string | null }) {
  const [open, setOpen] = useState(false);
  if (!message) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-medium text-brand-600 hover:underline"
      >
        {open ? 'Hide' : 'View'}
      </button>
      {open && (
        <pre className="mt-2 max-w-md overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs text-slate-700">
          {message}
        </pre>
      )}
    </div>
  );
}

export default function WebhookDeliveriesPage() {
  const params = useParams<{ id: string }>();
  const subId = params.id;
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
  } = useWebhookDeliveries(tenantId, subId);

  const rows: WebhookDeliveryItem[] = data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Link
          href="/settings/webhooks"
          className="text-sm text-slate-500 transition-colors hover:text-slate-800"
        >
          &larr; Webhooks
        </Link>
        <h1 className="text-xl font-semibold text-[#0f172a]">Recent deliveries</h1>
      </div>

      <Card
        title="Delivery attempts"
        subtitle="Newest first. `failed` rows have exhausted all retries; `pending` are queued for the next worker tick."
      >
        {isLoading && <p className="py-6 text-center text-sm text-slate-400">Loading&hellip;</p>}
        {isError && (
          <p className="py-6 text-center text-sm text-red-500">Failed to load deliveries.</p>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">
            No deliveries yet — fire an event that this subscription listens to.
          </p>
        )}
        {!isLoading && !isError && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">When (IST)</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Event</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Attempts</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Delivered</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Next attempt</th>
                  <th className="pb-2 font-medium text-slate-500">Last error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {fmt(r.createdAt)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-700">
                      {r.eventType}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone={statusTone(r.status)} label={r.status} />
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">{r.attempts}</td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {fmt(r.deliveredAt)}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {fmt(r.nextAttemptAt)}
                    </td>
                    <td className="py-2.5">
                      <ErrorToggle message={r.lastError} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
