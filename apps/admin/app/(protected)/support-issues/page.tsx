'use client';
import { useState } from 'react';
import { useAdminSupportIssues, useUpdateSupportIssue } from '@/lib/api/queries';
import type { AdminSupportIssue, SupportIssueStatus, SupportIssuePriority } from '@/lib/api/types';

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

function IssueRow({ issue }: { issue: AdminSupportIssue }) {
  const update = useUpdateSupportIssue();
  const [status, setStatus] = useState<SupportIssueStatus>(issue.status);
  const [priority, setPriority] = useState<SupportIssuePriority>(issue.priority);

  async function handleStatusChange(newStatus: SupportIssueStatus) {
    setStatus(newStatus);
    await update.mutateAsync({ id: issue.id, status: newStatus });
  }

  async function handlePriorityChange(newPriority: SupportIssuePriority) {
    setPriority(newPriority);
    await update.mutateAsync({ id: issue.id, priority: newPriority });
  }

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <td className="px-4 py-3">
        <p className="max-w-md text-sm text-slate-800 line-clamp-3">{issue.message}</p>
        <p className="mt-0.5 text-xs text-slate-400 font-mono">{issue.userId}</p>
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
  );
}

export default function SupportIssuesPage() {
  const { data: issues, isLoading, error } = useAdminSupportIssues();
  const [filterStatus, setFilterStatus] = useState<SupportIssueStatus | 'all'>('all');

  const filtered = issues?.filter(
    (i) => filterStatus === 'all' || i.status === filterStatus,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Support Issues</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Issues submitted by partners via the Help Centre.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Filter:</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as SupportIssueStatus | 'all')}
            className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
          >
            <option value="all">All</option>
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

      {filtered && filtered.length === 0 && !isLoading && (
        <p className="text-sm text-slate-500">No issues found.</p>
      )}

      {filtered && filtered.length > 0 && (
        <div className="overflow-auto rounded-[var(--radius)] border border-[#e5e7eb] bg-white">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Message</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">Submitted</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Priority</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((issue) => (
                <IssueRow key={issue.id} issue={issue} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
