'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { useQuestionThreads } from '@/lib/api/questions';
import type {
  QuestionOrigin,
  QuestionStatus,
  QuestionSubjectType,
  QuestionThreadRow,
  QuestionVisibility,
} from '@/lib/api/types';
import { Badge, Button, Card } from '@/lib/ui';
import { CATEGORY_LABELS, SUBJECT_LABELS } from './labels';

/** The three status tabs list active threads; Archived is its own view. */
type TabKey = QuestionStatus | 'archived';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'open',     label: 'Open' },
  { key: 'answered', label: 'Answered' },
  { key: 'closed',   label: 'Closed' },
  { key: 'archived', label: 'Archived' },
];

function VisibilityBadge({ visibility }: { visibility: QuestionVisibility }) {
  return visibility === 'public' ? (
    <Badge tone="booked" label="Public" />
  ) : (
    <Badge tone="held" label="Private" />
  );
}

function ThreadList({ tenantId, tab }: { tenantId: string; tab: TabKey }) {
  const archived = tab === 'archived';
  const { resolveTz } = useTimezone();
  const [visibilityFilter, setVisibilityFilter] = useState<'' | QuestionVisibility>('');
  const [subjectFilter, setSubjectFilter] = useState<'' | QuestionSubjectType>('');
  const [originFilter, setOriginFilter] = useState<'' | QuestionOrigin>('');

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
    // The Archived tab shows archived threads of every status; the status
    // tabs list active (non-archived) threads only.
    ...(archived ? { archived: true } : { status: tab as QuestionStatus }),
    ...(visibilityFilter ? { visibility: visibilityFilter } : {}),
    ...(subjectFilter ? { subjectType: subjectFilter } : {}),
    ...(originFilter ? { origin: originFilter } : {}),
  });

  const rows: QuestionThreadRow[] = data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500">Type</label>
          <select
            value={originFilter}
            onChange={(e) => setOriginFilter(e.target.value as '' | QuestionOrigin)}
            className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">All</option>
            <option value="forum">Questions</option>
            <option value="support">Support requests</option>
          </select>
        </div>
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
            <option value="general">General</option>
          </select>
        </div>
        {(visibilityFilter || subjectFilter || originFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setVisibilityFilter('');
              setSubjectFilter('');
              setOriginFilter('');
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
            No {tab} questions
            {visibilityFilter || subjectFilter || originFilter ? ' match these filters' : ''}.
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
                  {row.origin === 'support' && (
                    <>
                      <Badge tone="support" label="Support" />
                      {row.category != null && (
                        <Badge tone="neutral" label={CATEGORY_LABELS[row.category]} />
                      )}
                    </>
                  )}
                  <VisibilityBadge visibility={row.visibility} />
                  {row.archivedAt != null && <Badge tone="warning" label="Archived" />}
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
  const [activeTab, setActiveTab] = useState<TabKey>('open');

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
            ? `Customer questions and support requests on ${activeTenant.name}'s events, arenas and memberships.`
            : 'Customer questions and support requests on your events, arenas and memberships.'}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#e5e7eb]">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={[
              'px-4 py-2 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-b-2 border-brand-600 text-brand-600'
                : 'text-slate-500 hover:text-slate-700',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <ThreadList tenantId={activeTenantId} tab={activeTab} />
    </div>
  );
}
