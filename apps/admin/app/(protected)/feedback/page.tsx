'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { useAdminFeedback } from '@/lib/api/queries';
import type {
  AdminFeedbackPage,
  AdminFeedbackPerson,
  AdminFeedbackView,
  AdminPollRow,
  AdminRatingKind,
  AdminRatingRow,
  AdminSiteFeedbackRow,
} from '@/lib/api/types';

const VIEWS: { key: AdminFeedbackView; label: string; blurb: string }[] = [
  {
    key: 'ratings',
    label: 'Ratings',
    blurb: 'Customers rate events once they end, venue visits and memberships a day after check-in (1–10).',
  },
  {
    key: 'consumer',
    label: 'Consumer survey',
    blurb: 'The consumer website survey, asked weekly until answered, once per person.',
  },
  {
    key: 'partner',
    label: 'Partner survey',
    blurb: 'The partner portal survey, asked of Owners and Managers weekly until someone in the org answers.',
  },
  {
    key: 'poll',
    label: 'Event-type poll',
    blurb: 'What kind of event customers would like to see next, asked once of everyone; “Other” shows what they typed.',
  },
];

const KINDS: { key: AdminRatingKind | 'all'; label: string }[] = [
  { key: 'all', label: 'All ratings' },
  { key: 'event_feedback', label: 'Events' },
  { key: 'venue_feedback', label: 'Venue visits' },
  { key: 'membership_feedback', label: 'Memberships' },
];

const KIND_LABEL: Record<AdminRatingKind, string> = {
  event_feedback: 'Event',
  venue_feedback: 'Venue visit',
  membership_feedback: 'Membership',
};

const SELECT =
  'rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-slate-400 focus:outline-none';
const TH = 'px-4 py-2 font-medium';
const TD = 'px-4 py-2.5 align-top';

const DATE = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** A summary number, in the dashboard's tile style. */
function Stat({ label, value, petal, suffix }: { label: string; value: number | null | undefined; petal: string; suffix?: string }) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-[var(--radius)] border-2 border-[#17151D] bg-white p-4 shadow-[4px_4px_0_#17151D]">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-full border-2 border-[#17151D]"
          style={{ backgroundColor: petal }}
        />
        <span className="text-xs font-semibold text-slate-600">{label}</span>
      </div>
      <span className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight tabular-nums text-[#17151D]">
        {value == null ? '—' : value}
        {value != null && suffix && <span className="ml-1 text-base font-semibold text-slate-400">{suffix}</span>}
      </span>
    </div>
  );
}

/** A 1–10 score as a coloured chip; "—" for "haven't tried". */
function Score({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-slate-400" title="Haven’t tried yet">—</span>;
  const tone =
    value >= 8 ? 'bg-[#BCE3A0]' : value >= 5 ? 'bg-[#FCE38A]' : 'bg-[#FFB0A3]';
  return (
    <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full border-2 border-[#17151D] text-xs font-bold tabular-nums ${tone}`}>
      {value}
    </span>
  );
}

function Person({ p }: { p: AdminFeedbackPerson }) {
  return (
    <div className="text-xs">
      <div className="font-medium text-slate-700">{p.name ?? 'No name'}</div>
      {p.phone && <div className="text-slate-500">{p.phone}</div>}
      {p.email && <div className="text-slate-500">{p.email}</div>}
    </div>
  );
}

function Note({ text }: { text: string | null }) {
  if (!text) return <span className="text-xs text-slate-300">—</span>;
  return <p className="max-w-md whitespace-pre-wrap break-words text-sm text-slate-700">{text}</p>;
}

function OrgLink({ tenant }: { tenant: { id: string; name: string } | null }) {
  if (!tenant) return <span className="text-xs text-slate-300">—</span>;
  return (
    <Link href={`/tenants/${tenant.id}`} className="text-xs text-slate-600 hover:underline">
      {tenant.name}
    </Link>
  );
}

function RatingsTable({ rows }: { rows: AdminRatingRow[] }) {
  return (
    <table className="w-full min-w-[860px] text-sm">
      <thead className="border-b-2 border-[#17151D] bg-[#FAF3E8] text-left text-xs uppercase tracking-wide text-slate-500">
        <tr>
          <th className={TH}>When</th>
          <th className={TH}>Rated</th>
          <th className={TH}>Organiser</th>
          <th className={TH}>Score</th>
          <th className={TH}>Note</th>
          <th className={TH}>Customer</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className={`${TD} whitespace-nowrap text-xs text-slate-500`}>{DATE_TIME.format(new Date(r.createdAt))}</td>
            <td className={TD}>
              <div className="font-medium text-slate-800">{r.subject.name ?? '—'}</div>
              <div className="text-xs text-slate-400">
                {KIND_LABEL[r.kind]}
                {r.subject.place ? ` · ${r.subject.place}` : ''}
                {r.subject.date ? ` · ${DATE.format(new Date(r.subject.date))}` : ''}
              </div>
            </td>
            <td className={TD}>
              <OrgLink tenant={r.tenant} />
            </td>
            <td className={TD}>
              <Score value={r.rating} />
            </td>
            <td className={TD}>
              <Note text={r.comment} />
            </td>
            <td className={TD}>
              <Person p={r.person} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SiteTable({ rows, partner }: { rows: AdminSiteFeedbackRow[]; partner: boolean }) {
  return (
    <table className="w-full min-w-[980px] text-sm">
      <thead className="border-b-2 border-[#17151D] bg-[#FAF3E8] text-left text-xs uppercase tracking-wide text-slate-500">
        <tr>
          <th className={TH}>When</th>
          {partner && <th className={TH}>Organisation</th>}
          <th className={TH}>Overall</th>
          {partner ? (
            <>
              <th className={TH} title="Creating an event">Events</th>
              <th className={TH} title="Creating a venue">Venues</th>
              <th className={TH} title="Creating a membership plan">Plans</th>
            </>
          ) : (
            <>
              <th className={TH} title="Finding things to do">Finding</th>
              <th className={TH} title="Booking and paying">Booking</th>
            </>
          )}
          <th className={TH}>Challenges</th>
          <th className={TH}>Other comments</th>
          <th className={TH}>{partner ? 'Answered by' : 'Customer'}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className={`${TD} whitespace-nowrap text-xs text-slate-500`}>{DATE_TIME.format(new Date(r.createdAt))}</td>
            {partner && (
              <td className={TD}>
                <OrgLink tenant={r.tenant} />
              </td>
            )}
            <td className={TD}>
              <Score value={r.overallRating} />
            </td>
            {partner ? (
              <>
                <td className={TD}><Score value={r.eventCreationRating} /></td>
                <td className={TD}><Score value={r.venueCreationRating} /></td>
                <td className={TD}><Score value={r.membershipCreationRating} /></td>
              </>
            ) : (
              <>
                <td className={TD}><Score value={r.discoveryRating} /></td>
                <td className={TD}><Score value={r.bookingRating} /></td>
              </>
            )}
            <td className={TD}>
              <Note text={r.challenges} />
            </td>
            <td className={TD}>
              <Note text={r.comments} />
            </td>
            <td className={TD}>
              <Person p={r.person} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PollTable({ rows }: { rows: AdminPollRow[] }) {
  return (
    <table className="w-full min-w-[720px] text-sm">
      <thead className="border-b-2 border-[#17151D] bg-[#FAF3E8] text-left text-xs uppercase tracking-wide text-slate-500">
        <tr>
          <th className={TH}>When</th>
          <th className={TH}>Question</th>
          <th className={TH}>Answer</th>
          <th className={TH}>Customer</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className={`${TD} whitespace-nowrap text-xs text-slate-500`}>{DATE_TIME.format(new Date(r.createdAt))}</td>
            <td className={`${TD} text-slate-600`}>{r.question}</td>
            <td className={TD}>
              <div className="font-medium text-slate-800">{r.answer}</div>
              {r.other && <p className="max-w-md whitespace-pre-wrap break-words text-sm text-slate-600">“{r.other}”</p>}
            </td>
            <td className={TD}>
              <Person p={r.person} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Summary({ page }: { page: AdminFeedbackPage | undefined }) {
  // Only the first page carries the summary.
  if (!page || !page.summary) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Responses" value={undefined} petal="#A9C9F2" />
      </div>
    );
  }
  switch (page.view) {
    case 'ratings':
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Ratings" value={page.summary.count} petal="#A9C9F2" />
          <Stat label="Average" value={page.summary.average} petal="#CDBBF7" suffix="/ 10" />
          <Stat label={`Events (${page.summary.events.count})`} value={page.summary.events.average} petal="#9CE0D4" suffix="/ 10" />
          <Stat label={`Venue visits (${page.summary.venues.count})`} value={page.summary.venues.average} petal="#BCE3A0" suffix="/ 10" />
          <Stat
            label={`Memberships (${page.summary.memberships.count})`}
            value={page.summary.memberships.average}
            petal="#F9B4D4"
            suffix="/ 10"
          />
        </div>
      );
    case 'consumer':
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Responses" value={page.summary.count} petal="#A9C9F2" />
          <Stat label="Overall ease" value={page.summary.overall} petal="#CDBBF7" suffix="/ 10" />
          <Stat label="Finding things to do" value={page.summary.discovery} petal="#9CE0D4" suffix="/ 10" />
          <Stat label="Booking and paying" value={page.summary.booking} petal="#BCE3A0" suffix="/ 10" />
        </div>
      );
    case 'partner':
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Organisations" value={page.summary.count} petal="#A9C9F2" />
          <Stat label="Overall ease" value={page.summary.overall} petal="#CDBBF7" suffix="/ 10" />
          <Stat label="Creating events" value={page.summary.eventCreation} petal="#9CE0D4" suffix="/ 10" />
          <Stat label="Creating venues" value={page.summary.venueCreation} petal="#BCE3A0" suffix="/ 10" />
          <Stat label="Creating plans" value={page.summary.membershipCreation} petal="#F9B4D4" suffix="/ 10" />
        </div>
      );
    case 'poll':
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Answers" value={page.summary.count} petal="#A9C9F2" />
          </div>
          {page.summary.answers.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {page.summary.answers.map((a) => (
                <li
                  key={a.answer}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700"
                >
                  {a.answer} <span className="font-semibold tabular-nums">{a.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
  }
}

export default function FeedbackPage() {
  const [view, setView] = useState<AdminFeedbackView>('ratings');
  const [kind, setKind] = useState<AdminRatingKind | 'all'>('all');
  const filters = useMemo(
    () => ({ view, ...(view === 'ratings' && kind !== 'all' ? { kind } : {}) }),
    [view, kind],
  );
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error } =
    useAdminFeedback(filters);
  const first = data?.pages[0];
  const viewInfo = VIEWS.find((v) => v.key === view)!;

  const table = (() => {
    if (!data || !first) return null;
    if (first.view === 'ratings') {
      const rows = data.pages.flatMap((p) => (p.view === 'ratings' ? p.rows : []));
      return rows.length ? <RatingsTable rows={rows} /> : null;
    }
    if (first.view === 'poll') {
      const rows = data.pages.flatMap((p) => (p.view === 'poll' ? p.rows : []));
      return rows.length ? <PollTable rows={rows} /> : null;
    }
    const rows = data.pages.flatMap((p) => (p.view === 'consumer' || p.view === 'partner' ? p.rows : []));
    return rows.length ? <SiteTable rows={rows} partner={first.view === 'partner'} /> : null;
  })();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-[#17151D]">Feedback</h1>
        <p className="text-sm text-slate-500">What customers and partners tell us through the in-app prompts.</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Feedback type">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              className={
                view === v.key
                  ? 'rounded-md border border-[#17151D] bg-brand-600 px-3 py-1 text-xs font-medium text-slate-900'
                  : 'rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50'
              }
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === 'ratings' && (
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AdminRatingKind | 'all')}
            className={SELECT}
            aria-label="What was rated"
          >
            {KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <Summary page={first?.view === view ? first : undefined} />

      <p className="text-xs text-slate-400">
        {viewInfo.blurb}
        {view === 'consumer' || view === 'partner'
          ? ' Scores run from 1 to 10; a dash means they haven’t tried that part yet.'
          : ''}{' '}
        Phone numbers and emails are as they were when the person answered, or their current ones where none
        was saved then.
      </p>

      <div className="overflow-x-auto rounded-lg border-2 border-[#17151D] bg-white shadow-[4px_4px_0_#17151D]">
        {isLoading && <p className="px-4 py-8 text-center text-sm text-slate-400">Loading…</p>}
        {isError && (
          <p className="px-4 py-8 text-center text-sm text-red-600">
            {error instanceof ApiError && error.code === 'forbidden_capability'
              ? 'Your platform role cannot see feedback (it shows who answered).'
              : `Failed to load: ${error instanceof Error ? error.message : 'unknown error'}`}
          </p>
        )}
        {!isLoading && !isError && (table ?? <p className="px-4 py-8 text-center text-sm text-slate-400">No feedback yet.</p>)}
      </div>

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
