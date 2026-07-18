'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { useAdminQuestions } from '@/lib/api/queries';
import type {
  AdminQuestionFilters,
  AdminQuestionThreadRow,
  QuestionOrigin,
  QuestionStatus,
  QuestionSubjectType,
  QuestionVisibility,
} from '@/lib/api/types';

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
} from './badges';

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function ThreadRow({ row }: { row: AdminQuestionThreadRow }) {
  const router = useRouter();
  return (
    <tr
      onClick={() => router.push(`/questions/${row.id}`)}
      className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
    >
      <td className="px-4 py-3">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          {row.origin === 'support' && (
            <Badge label={ORIGIN_LABELS.support} tone={ORIGIN_COLORS.support} />
          )}
          <Badge label={SUBJECT_TYPE_LABELS[row.subjectType]} tone={SUBJECT_TYPE_COLORS[row.subjectType]} />
          {row.subject?.name ? (
            <span className="text-xs font-medium text-slate-700">{row.subject.name}</span>
          ) : row.subjectId ? (
            <span className="font-mono text-[10px] text-slate-400">{row.subjectId.slice(0, 8)}…</span>
          ) : null}
          {row.category && (
            <span className="text-xs font-medium text-slate-600">
              {CATEGORY_LABELS[row.category]}
            </span>
          )}
        </div>
        <p className="max-w-md text-sm text-slate-800 line-clamp-2 whitespace-pre-line">{row.rootBody}</p>
        <p className="mt-0.5 text-xs text-slate-500">{row.authorName}</p>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">
        {row.tenantId.slice(0, 8)}…
      </td>
      <td className="px-4 py-3">
        <Badge label={VISIBILITY_LABELS[row.visibility]} tone={VISIBILITY_COLORS[row.visibility]} />
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1">
          <Badge label={STATUS_LABELS[row.status]} tone={STATUS_COLORS[row.status]} />
          {row.archivedAt !== null && (
            <Badge
              label={row.archivedByKind === 'circls' ? 'Archived by Circls' : 'Archived by org'}
              tone="bg-amber-100 text-amber-800"
            />
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-center text-sm text-slate-700">{row.replyCount}</td>
      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
        {IST_FMT.format(new Date(row.lastMessageAt))}
      </td>
    </tr>
  );
}

function QuestionsPageContent() {
  // `/questions?origin=support` (linked from Support Issues) pre-selects the
  // origin filter; the select stays fully interactive afterwards.
  const searchParams = useSearchParams();
  const originParam = searchParams.get('origin');
  const initialOrigin: QuestionOrigin | 'all' =
    originParam === 'support' || originParam === 'forum' ? originParam : 'all';

  const [filterStatus, setFilterStatus] = useState<QuestionStatus | 'all'>('all');
  const [filterVisibility, setFilterVisibility] = useState<QuestionVisibility | 'all'>('all');
  const [filterSubjectType, setFilterSubjectType] = useState<QuestionSubjectType | 'all'>('all');
  const [filterOrigin, setFilterOrigin] = useState<QuestionOrigin | 'all'>(initialOrigin);
  const [filterArchived, setFilterArchived] = useState<'active' | 'archived'>('active');
  const [tenantIdInput, setTenantIdInput] = useState('');

  const tenantIdTrimmed = tenantIdInput.trim();
  const tenantIdInvalid = tenantIdTrimmed !== '' && !isUuid(tenantIdTrimmed);

  const filters: AdminQuestionFilters = {
    ...(filterStatus !== 'all' ? { status: filterStatus } : {}),
    ...(filterVisibility !== 'all' ? { visibility: filterVisibility } : {}),
    ...(filterSubjectType !== 'all' ? { subjectType: filterSubjectType } : {}),
    ...(filterOrigin !== 'all' ? { origin: filterOrigin } : {}),
    ...(filterArchived === 'archived' ? { archived: true } : {}),
    // Only send the tenant filter once it's a full, valid UUID.
    ...(tenantIdTrimmed && !tenantIdInvalid ? { tenantId: tenantIdTrimmed } : {}),
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    error,
  } = useAdminQuestions(filters);

  const rows: AdminQuestionThreadRow[] = useMemo(
    () => data?.pages.flatMap((p) => p.rows) ?? [],
    [data],
  );

  const selectCls =
    'rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Questions</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Consumer questions on events, arenas and memberships across all orgs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Filter:</span>
          <select
            value={filterOrigin}
            onChange={(e) => setFilterOrigin(e.target.value as QuestionOrigin | 'all')}
            className={selectCls}
            aria-label="Filter by origin"
          >
            <option value="all">All origins</option>
            <option value="forum">Forum</option>
            <option value="support">Support</option>
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as QuestionStatus | 'all')}
            className={selectCls}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="answered">Answered</option>
            <option value="closed">Closed</option>
          </select>
          <select
            value={filterVisibility}
            onChange={(e) => setFilterVisibility(e.target.value as QuestionVisibility | 'all')}
            className={selectCls}
            aria-label="Filter by visibility"
          >
            <option value="all">All visibilities</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
          <select
            value={filterSubjectType}
            onChange={(e) => setFilterSubjectType(e.target.value as QuestionSubjectType | 'all')}
            className={selectCls}
            aria-label="Filter by subject type"
          >
            <option value="all">All subjects</option>
            <option value="event">Events</option>
            <option value="arena">Arenas</option>
            <option value="membership">Memberships</option>
            <option value="general">General</option>
          </select>
          <select
            value={filterArchived}
            onChange={(e) => setFilterArchived(e.target.value as 'active' | 'archived')}
            className={selectCls}
            aria-label="Filter archived threads"
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
          <input
            value={tenantIdInput}
            onChange={(e) => setTenantIdInput(e.target.value)}
            placeholder="Tenant ID (UUID)"
            aria-label="Filter by tenant ID"
            className={[
              'w-44 rounded border bg-white px-2 py-1.5 font-mono text-xs text-slate-700',
              tenantIdInvalid ? 'border-rose-300' : 'border-slate-200',
            ].join(' ')}
          />
        </div>
      </div>

      {tenantIdInvalid && (
        <p className="-mt-4 text-right text-xs text-rose-600">
          Tenant filter is applied once a full UUID is entered.
        </p>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
          Loading…
        </div>
      )}

      {error && <p className="text-sm text-red-600">Failed to load questions.</p>}

      {!isLoading && !error && rows.length === 0 && (
        <p className="text-sm text-slate-500">No questions found.</p>
      )}

      {rows.length > 0 && (
        <div className="overflow-auto rounded-[var(--radius)] border border-[#e5e7eb] bg-white">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Question</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Tenant</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Visibility</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Replies</th>
                <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 whitespace-nowrap">Last activity (IST)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ThreadRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function QuestionsPage() {
  // useSearchParams requires a Suspense boundary for static prerendering.
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
          Loading…
        </div>
      }
    >
      <QuestionsPageContent />
    </Suspense>
  );
}
