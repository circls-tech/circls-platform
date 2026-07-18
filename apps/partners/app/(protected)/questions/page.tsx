'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { useQuestionThreads } from '@/lib/api/questions';
import type {
  QuestionStatus,
  QuestionSubjectType,
  QuestionThreadRow,
  QuestionVisibility,
} from '@/lib/api/types';
import { Badge, Button, Card } from '@/lib/ui';

const TABS: { status: QuestionStatus; label: string }[] = [
  { status: 'open',     label: 'Open' },
  { status: 'answered', label: 'Answered' },
  { status: 'closed',   label: 'Closed' },
];

const SUBJECT_LABELS: Record<QuestionSubjectType, string> = {
  event:      'Event',
  arena:      'Arena',
  membership: 'Membership',
};

function VisibilityBadge({ visibility }: { visibility: QuestionVisibility }) {
  return visibility === 'public' ? (
    <Badge tone="booked" label="Public" />
  ) : (
    <Badge tone="held" label="Private" />
  );
}

function ThreadList({ tenantId, status }: { tenantId: string; status: QuestionStatus }) {
  const { resolveTz } = useTimezone();
  const [visibilityFilter, setVisibilityFilter] = useState<'' | QuestionVisibility>('');
  const [subjectFilter, setSubjectFilter] = useState<'' | QuestionSubjectType>('');

  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: resolveTz(),
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    [resolveTz],
  );

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useQuestionThreads(tenantId, {
    status,
    ...(visibilityFilter ? { visibility: visibilityFilter } : {}),
    ...(subjectFilter ? { subjectType: subjectFilter } : {}),
  });

  const rows: QuestionThreadRow[] = data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Visibility</label>
          <select
            value={visibilityFilter}
            onChange={(e) => setVisibilityFilter(e.target.value as '' | QuestionVisibility)}
            className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Subject</label>
          <select
            value={subjectFilter}
            onChange={(e) => setSubjectFilter(e.target.value as '' | QuestionSubjectType)}
            className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All</option>
            <option value="event">Events</option>
            <option value="arena">Arenas</option>
            <option value="membership">Memberships</option>
          </select>
        </div>
        {(visibilityFilter || subjectFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setVisibilityFilter('');
              setSubjectFilter('');
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {isLoading && <p className="py-6 text-center text-sm text-slate-400">Loading&hellip;</p>}
      {isError && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          Failed to load questions{error instanceof Error ? `: ${error.message}` : '.'}
        </p>
      )}
      {!isLoading && !isError && rows.length === 0 && (
        <Card>
          <p className="py-4 text-center text-sm text-slate-400">
            No {status} questions{visibilityFilter || subjectFilter ? ' match these filters' : ''}.
          </p>
        </Card>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/questions/${row.id}`}
                className="block rounded-[var(--radius)] border border-[#e5e7eb] bg-white p-4 shadow-sm transition-colors hover:border-brand-300 hover:bg-slate-50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-900">
                    {row.subject?.name ?? 'Listing'}
                  </span>
                  <Badge tone="neutral" label={SUBJECT_LABELS[row.subjectType]} />
                  <VisibilityBadge visibility={row.visibility} />
                  <span className="ml-auto whitespace-nowrap text-xs text-slate-400">
                    {fmt.format(new Date(row.lastMessageAt))}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-sm text-slate-600">{row.rootBody}</p>
                <p className="mt-1.5 text-xs text-slate-400">
                  {row.authorName}
                  {' · '}
                  {row.replyCount === 1 ? '1 reply' : `${row.replyCount} replies`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hasNextPage && (
        <div className="flex justify-center">
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
    </div>
  );
}

export default function QuestionsPage() {
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId);
  const [activeTab, setActiveTab] = useState<QuestionStatus>('open');

  if (!activeTenantId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-[#0f172a]">Questions</h1>
        <Card subtitle="Select or create an organization first to view its questions.">
          <p className="text-sm text-slate-500">
            No active organization. Use the switcher in the top bar to pick one.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[#0f172a]">Questions</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {activeTenant
            ? `Customer questions on ${activeTenant.name}'s events, arenas and memberships.`
            : 'Customer questions on your events, arenas and memberships.'}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#e5e7eb]">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            onClick={() => setActiveTab(tab.status)}
            className={[
              'px-4 py-2 text-sm font-medium transition-colors',
              activeTab === tab.status
                ? 'border-b-2 border-brand-600 text-brand-600'
                : 'text-slate-500 hover:text-slate-700',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <ThreadList tenantId={activeTenantId} status={activeTab} />
    </div>
  );
}
