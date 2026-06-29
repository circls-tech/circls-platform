'use client';
import { useState } from 'react';
import { useAdminSupportIssues, useUpdateSupportIssue } from '@/lib/api/queries';
import type {
  AdminSupportIssue,
  SupportIssueCategory,
  SupportIssuePriority,
  SupportIssueSource,
  SupportIssueStatus,
} from '@/lib/api/types';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const STATUS_LABELS: Record<SupportIssueStatus, string> = {
  unresolved: 'Unresolved',
  in_progress: 'In Progress',
  backlog: 'Backlog',
  resolved: 'Resolved',
};

const STATUS_COLORS: Record<SupportIssueStatus, string> = {
  unresolved: 'bg-red-100 text-red-800',
  in_progress: 'bg-amber-100 text-amber-800',
  backlog: 'bg-slate-100 text-slate-700',
  resolved: 'bg-green-100 text-green-800',
};

const PRIORITY_COLORS: Record<SupportIssuePriority, string> = {
  low: 'text-slate-400',
  medium: 'text-amber-600',
  high: 'text-red-600',
};

const SOURCE_LABELS: Record<SupportIssueSource, string> = {
  partner_help: 'Partner',
  consumer_chatbot: 'Consumer',
};

const SOURCE_COLORS: Record<SupportIssueSource, string> = {
  partner_help: 'bg-indigo-100 text-indigo-800',
  consumer_chatbot: 'bg-teal-100 text-teal-800',
};

const CATEGORY_LABELS: Record<SupportIssueCategory, string> = {
  booking_issue: 'Booking issue',
  refund_request: 'Refund / cancel',
  reschedule: 'Reschedule',
  venue_question: 'Venue / event',
  payment: 'Payment',
  other: 'Other',
};

function SourceBadge({ source }: { source: SupportIssueSource }) {
  return (
    <span
      className={[
        'inline-block rounded px-2 py-0.5 text-xs font-medium',
        SOURCE_COLORS[source] ?? 'bg-slate-100 text-slate-700',
      ].join(' ')}
    >
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

function IssueRow({ issue }: { issue: AdminSupportIssue }) {
  const update = useUpdateSupportIssue();
  const [status, setStatus] = useState<SupportIssueStatus>(issue.status);
  const [priority, setPriority] = useState<SupportIssuePriority>(issue.priority);
  const [expanded, setExpanded] = useState(false);

  const hasTranscript = (issue.flowAnswers?.length ?? 0) > 0;

  async function handleStatusChange(newStatus: SupportIssueStatus) {
    setStatus(newStatus);
    await update.mutateAsync({ id: issue.id, status: newStatus });
  }

  async function handlePriorityChange(newPriority: SupportIssuePriority) {
    setPriority(newPriority);
    await update.mutateAsync({ id: issue.id, priority: newPriority });
  }

  return (
    <>
      <tr className="border-b border-slate-100 hover:bg-slate-50 align-top">
        <td className="px-4 py-3">
          <div className="mb-1 flex items-center gap-2">
            <SourceBadge source={issue.source} />
            {issue.category && (
              <span className="text-xs font-medium text-slate-600">
                {CATEGORY_LABELS[issue.category] ?? issue.category}
              </span>
            )}
          </div>
          <p className="max-w-md text-sm text-slate-800 line-clamp-3 whitespace-pre-line">{issue.message}</p>
          <p className="mt-0.5 text-xs text-slate-400 font-mono">{issue.userId}</p>
          {hasTranscript && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs font-medium text-indigo-600 hover:underline"
            >
              {expanded ? 'Hide' : 'Show'} flow transcript ({issue.flowAnswers!.length})
            </button>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-slate-600">
          {issue.booking ? (
            <div className="whitespace-nowrap">
              <p className="font-medium text-slate-700">{issue.booking.venueName ?? 'Booking'}</p>
              <p className="text-slate-500">{issue.booking.itemType} · {issue.booking.status}</p>
              <p className="font-mono text-[10px] text-slate-400">{issue.booking.id.slice(0, 8)}</p>
            </div>
          ) : (
            <span className="text-slate-300">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
          {IST_FMT.format(new Date(issue.createdAt))}
        </td>
        <td className="px-4 py-3">
          <select
            value={status}
            onChange={(e) => void handleStatusChange(e.target.value as SupportIssueStatus)}
            disabled={update.isPending}
            className={[
              'rounded px-2 py-1 text-xs font-medium border-0 cursor-pointer',
              STATUS_COLORS[status],
            ].join(' ')}
          >
            {(Object.keys(STATUS_LABELS) as SupportIssueStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </td>
        <td className="px-4 py-3">
          <select
            value={priority}
            onChange={(e) => void handlePriorityChange(e.target.value as SupportIssuePriority)}
            disabled={update.isPending}
            className={[
              'rounded px-2 py-1 text-xs font-medium border border-slate-200 cursor-pointer capitalize',
              PRIORITY_COLORS[priority],
            ].join(' ')}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </td>
      </tr>
      {expanded && hasTranscript && (
        <tr className="border-b border-slate-100 bg-slate-50/70">
          <td colSpan={5} className="px-4 py-3">
            <ol className="space-y-1.5">
              {issue.flowAnswers!.map((a, i) => (
                <li key={i} className="text-xs text-slate-600">
                  <span className="text-slate-500">{a.question}</span>
                  <span className="mx-1 text-slate-400">→</span>
                  <span className="font-medium text-slate-800">{a.answer}</span>
                </li>
              ))}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}

export default function SupportIssuesPage() {
  const [filterSource, setFilterSource] = useState<SupportIssueSource | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState<SupportIssueCategory | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<SupportIssueStatus | 'all'>('all');

  // Server-side filtering (#114): pass through the filters the API supports.
  const { data: issues, isLoading, error } = useAdminSupportIssues({
    ...(filterSource !== 'all' ? { source: filterSource } : {}),
    ...(filterCategory !== 'all' ? { category: filterCategory } : {}),
    ...(filterStatus !== 'all' ? { status: filterStatus } : {}),
  });

  const selectCls =
    'rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Support Issues</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Partner Help Centre issues and consumer Help-chatbot concerns.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Filter:</span>
          <select
            value={filterSource}
            onChange={(e) => setFilterSource(e.target.value as SupportIssueSource | 'all')}
            className={selectCls}
            aria-label="Filter by source"
          >
            <option value="all">All sources</option>
            <option value="partner_help">Partner</option>
            <option value="consumer_chatbot">Consumer</option>
          </select>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value as SupportIssueCategory | 'all')}
            className={selectCls}
            aria-label="Filter by category"
          >
            <option value="all">All categories</option>
            {(Object.keys(CATEGORY_LABELS) as SupportIssueCategory[]).map((c) => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as SupportIssueStatus | 'all')}
            className={selectCls}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="unresolved">Unresolved</option>
            <option value="in_progress">In Progress</option>
            <option value="backlog">Backlog</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
          Loading…
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600">Failed to load support issues.</p>
      )}

      {issues && issues.length === 0 && !isLoading && (
        <p className="text-sm text-slate-500">No issues found.</p>
      )}

      {issues && issues.length > 0 && (
        <div className="overflow-auto rounded-[var(--radius)] border border-[#e5e7eb] bg-white">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Issue</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Booking</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">Submitted</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Priority</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
