'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { useNotifications } from '@/lib/api/queries';
import type { NotificationItem, NotificationChannel, NotificationStatus } from '@/lib/api/types';
import { Badge, Button, Card } from '@/lib/ui';

function statusTone(s: NotificationStatus): 'success' | 'warning' | 'open' | 'neutral' {
  if (s === 'sent')    return 'success';
  if (s === 'failed')  return 'warning';
  if (s === 'pending') return 'open';
  return 'neutral';
}

const CHANNELS: NotificationChannel[] = ['sms', 'email', 'whatsapp'];
const STATUSES: NotificationStatus[]  = ['pending', 'sent', 'failed', 'skipped'];

export default function NotificationsPage() {
  const { activeTenantId } = useOrg();
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

  function formatIST(iso: string | null): string {
    if (!iso) return '—';
    return fmt.format(new Date(iso));
  }

  const [channelFilter, setChannelFilter] = useState<'' | NotificationChannel>('');
  const [statusFilter, setStatusFilter]   = useState<'' | NotificationStatus>('');

  const params = {
    ...(channelFilter ? { channel: channelFilter } : {}),
    ...(statusFilter  ? { status:  statusFilter }  : {}),
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
  } = useNotifications(activeTenantId ?? '', params);

  const allRows: NotificationItem[] = data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:text-slate-800 transition-colors"
        >
          &larr; Settings
        </Link>
        <h1 className="text-xl font-semibold text-[#0f172a]">Notifications</h1>
      </div>

      <Card title="Filters">
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Channel</label>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value as '' | NotificationChannel)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All channels</option>
              {CHANNELS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as '' | NotificationStatus)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {(channelFilter || statusFilter) && (
            <div className="flex flex-col justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setChannelFilter('');
                  setStatusFilter('');
                }}
              >
                Clear
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Recent notifications"
        subtitle="Outbound SMS, email and WhatsApp messages dispatched for this organization."
      >
        {isLoading && (
          <p className="py-6 text-center text-sm text-slate-400">Loading&hellip;</p>
        )}
        {isError && (
          <p className="py-6 text-center text-sm text-red-500">Failed to load notifications.</p>
        )}
        {!isLoading && !isError && allRows.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">No notifications yet.</p>
        )}
        {!isLoading && !isError && allRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">When</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Channel</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Template</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Recipient</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Scheduled</th>
                  <th className="pb-2 font-medium text-slate-500">Sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {allRows.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {formatIST(row.createdAt)}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone="neutral" label={row.channel} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone={statusTone(row.status)} label={row.status} />
                      {row.error && (
                        <div className="mt-1 max-w-xs truncate text-xs text-red-500" title={row.error}>
                          {row.error}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-slate-700">
                      {row.templateKey}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">{row.recipient}</td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {formatIST(row.scheduledFor)}
                    </td>
                    <td className="py-2.5 text-xs text-slate-500 whitespace-nowrap">
                      {formatIST(row.sentAt)}
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
