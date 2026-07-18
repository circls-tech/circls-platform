'use client';

// "Customer context" panel for the admin thread detail page: who the asker
// is, the booking pinned by the support intake, cross-tenant bookings /
// memberships / prior threads, recent consumer activity and historical
// support issues. Data: GET /v1/admin/questions/:threadId/context.
import Link from 'next/link';
import { useState } from 'react';
import { useAdminQuestionContext } from '@/lib/api/queries';
import type { QuestionContextBooking } from '@/lib/api/types';
import {
  Badge,
  CATEGORY_LABELS,
  IST_FMT,
  ORIGIN_COLORS,
  ORIGIN_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  SUBJECT_TYPE_COLORS,
  SUBJECT_TYPE_LABELS,
  VISIBILITY_COLORS,
  VISIBILITY_LABELS,
} from '../badges';

const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

/** Render paise as rupees with 2 decimals (e.g. 123456 → "1,234.56"). */
function fmtRupees(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Historical support-issue badge maps (values arrive as plain strings — fall
// back to the raw value for anything unrecognised).
const ISSUE_SOURCE_LABELS: Record<string, string> = {
  partner_help: 'Partner',
  consumer_chatbot: 'Consumer',
};
const ISSUE_SOURCE_COLORS: Record<string, string> = {
  partner_help: 'bg-indigo-100 text-indigo-800',
  consumer_chatbot: 'bg-teal-100 text-teal-800',
};
const ISSUE_STATUS_LABELS: Record<string, string> = {
  unresolved: 'Unresolved',
  in_progress: 'In Progress',
  backlog: 'Backlog',
  resolved: 'Resolved',
};
const ISSUE_STATUS_COLORS: Record<string, string> = {
  unresolved: 'bg-red-100 text-red-800',
  in_progress: 'bg-amber-100 text-amber-800',
  backlog: 'bg-slate-100 text-slate-700',
  resolved: 'bg-green-100 text-green-800',
};

function ContextBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-slate-400">{text}</p>;
}

function BookingLine({ booking }: { booking: QuestionContextBooking }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-800">{booking.label}</span>
        <span className="text-xs capitalize text-slate-500">{booking.itemType}</span>
        <span className="text-xs capitalize text-slate-500">{booking.status}</span>
        {booking.totalPaise !== null && (
          <span className="text-xs text-slate-600">
            ₹{fmtRupees(booking.totalPaise)} · {booking.paymentMethod}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        {booking.timeRange ? (
          <span>
            {IST_FMT.format(new Date(booking.timeRange.start))} –{' '}
            {IST_FMT.format(new Date(booking.timeRange.end))} IST
          </span>
        ) : (
          <span>Booked {IST_FMT.format(new Date(booking.createdAt))} IST</span>
        )}
        <span className="font-mono text-[10px] text-slate-400">{booking.id.slice(0, 8)}…</span>
      </div>
    </div>
  );
}

export function CustomerContextPanel({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(true);
  const { data, isLoading, isError } = useAdminQuestionContext(threadId);

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-slate-900">Customer context</span>
        <span className="text-xs text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-4">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
              Loading context…
            </div>
          )}
          {isError && <p className="text-sm text-red-600">Failed to load customer context.</p>}

          {data && (
            <div className="grid gap-5 md:grid-cols-2">
              {/* Member — contact details always visible on the admin surface. */}
              <ContextBlock title="Member">
                <p className="text-sm font-medium text-slate-800">{data.member.displayName}</p>
                <div className="mt-0.5 space-y-0.5 text-xs text-slate-600">
                  <p>Member since {IST_DATE.format(new Date(data.member.memberSince))}</p>
                  <p>Email: {data.member.email ?? '—'}</p>
                  <p>Phone: {data.member.phone ?? '—'}</p>
                  <p className="font-mono text-[10px] text-slate-400">{data.member.id}</p>
                </div>
              </ContextBlock>

              <ContextBlock title="Pinned booking">
                {data.contextBooking ? (
                  <BookingLine booking={data.contextBooking} />
                ) : (
                  <EmptyNote text="No booking pinned to this thread." />
                )}
              </ContextBlock>

              <ContextBlock title="Recent bookings (all orgs)">
                {data.recentBookings.length === 0 ? (
                  <EmptyNote text="No bookings." />
                ) : (
                  <div className="space-y-1.5">
                    {data.recentBookings.map((b) => (
                      <BookingLine key={b.id} booking={b} />
                    ))}
                  </div>
                )}
              </ContextBlock>

              <ContextBlock title="Memberships">
                {data.memberships.length === 0 ? (
                  <EmptyNote text="No memberships." />
                ) : (
                  <ul className="space-y-1.5">
                    {data.memberships.map((m) => (
                      <li key={m.id} className="text-xs text-slate-600">
                        <span className="font-medium text-slate-800">{m.name}</span>
                        <span className="ml-2 capitalize">{m.status}</span>
                        <span className="ml-2 text-slate-500">
                          {IST_DATE.format(new Date(m.startsAt))} –{' '}
                          {IST_DATE.format(new Date(m.endsAt))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </ContextBlock>

              <ContextBlock title="Prior threads (all orgs)">
                {data.priorThreads.length === 0 ? (
                  <EmptyNote text="No other threads by this member." />
                ) : (
                  <ul className="space-y-1.5">
                    {data.priorThreads.map((p) => (
                      <li key={p.id}>
                        <Link
                          href={`/questions/${p.id}`}
                          className="flex flex-wrap items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 hover:bg-slate-50"
                        >
                          {p.origin === 'support' && (
                            <Badge label={ORIGIN_LABELS.support} tone={ORIGIN_COLORS.support} />
                          )}
                          <Badge
                            label={SUBJECT_TYPE_LABELS[p.subject.type]}
                            tone={SUBJECT_TYPE_COLORS[p.subject.type]}
                          />
                          <span className="text-xs font-medium text-slate-700">
                            {p.subject.name}
                          </span>
                          {p.category && (
                            <span className="text-xs text-slate-500">
                              {CATEGORY_LABELS[p.category]}
                            </span>
                          )}
                          <Badge label={STATUS_LABELS[p.status]} tone={STATUS_COLORS[p.status]} />
                          <Badge
                            label={VISIBILITY_LABELS[p.visibility]}
                            tone={VISIBILITY_COLORS[p.visibility]}
                          />
                          <span className="ml-auto text-[10px] text-slate-400">
                            {IST_FMT.format(new Date(p.lastMessageAt))}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </ContextBlock>

              <ContextBlock title="Recent activity">
                {data.recentActivity.length === 0 ? (
                  <EmptyNote text="No recent activity." />
                ) : (
                  <div className="overflow-auto rounded-md border border-slate-200">
                    <table className="min-w-full text-left">
                      <thead>
                        <tr className="border-b border-slate-100 bg-slate-50">
                          <th className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            Event
                          </th>
                          <th className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            Item
                          </th>
                          <th className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">
                            When (IST)
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.recentActivity.map((a) => (
                          <tr key={a.id} className="border-b border-slate-100 last:border-b-0">
                            <td className="px-2.5 py-1.5 text-xs text-slate-700">{a.eventType}</td>
                            <td className="px-2.5 py-1.5 text-xs text-slate-500">
                              {a.itemType ? (
                                <>
                                  {a.itemType}
                                  {a.itemId && (
                                    <span className="ml-1 font-mono text-[10px] text-slate-400">
                                      {a.itemId.slice(0, 8)}…
                                    </span>
                                  )}
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-2.5 py-1.5 text-xs text-slate-500 whitespace-nowrap">
                              {IST_FMT.format(new Date(a.createdAt))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </ContextBlock>

              <ContextBlock title="Historical support issues">
                {data.supportIssues.length === 0 ? (
                  <EmptyNote text="No support issues on record." />
                ) : (
                  <ul className="space-y-1.5">
                    {data.supportIssues.map((s) => (
                      <li key={s.id} className="rounded-md border border-slate-200 px-2.5 py-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge
                            label={ISSUE_SOURCE_LABELS[s.source] ?? s.source}
                            tone={ISSUE_SOURCE_COLORS[s.source] ?? 'bg-slate-100 text-slate-700'}
                          />
                          {s.category && (
                            <span className="text-xs text-slate-500">
                              {CATEGORY_LABELS[s.category as keyof typeof CATEGORY_LABELS] ??
                                s.category}
                            </span>
                          )}
                          <Badge
                            label={ISSUE_STATUS_LABELS[s.status] ?? s.status}
                            tone={ISSUE_STATUS_COLORS[s.status] ?? 'bg-slate-100 text-slate-700'}
                          />
                          <span className="ml-auto text-[10px] text-slate-400">
                            {IST_FMT.format(new Date(s.createdAt))}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-600 line-clamp-2 whitespace-pre-line">
                          {s.messageExcerpt}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </ContextBlock>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
