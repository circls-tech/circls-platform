'use client';

import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { ApiError } from '@/lib/api/client';
import { asCurrencyCode, formatMoney } from '@/lib/currency';
import {
  useArchiveQuestionThread,
  useModerateQuestionMessage,
  useQuestionContext,
  useQuestionThread,
  useReplyToQuestion,
  useSetQuestionStatus,
} from '@/lib/api/questions';
import type {
  QuestionContextBooking,
  QuestionFlowAnswer,
  QuestionMessage,
  QuestionStatus,
  QuestionThreadDetailThread,
} from '@/lib/api/types';
import { Badge, Button, Card, StatusPill } from '@/lib/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CATEGORY_LABELS, SUBJECT_LABELS } from '../labels';

const MAX_BODY = 2000;

/**
 * Portal page for the thread's subject. Memberships have no per-id page and
 * `general` threads (support requests with no listing) have no subject at all.
 */
function subjectHref(thread: QuestionThreadDetailThread): string | null {
  switch (thread.subjectType) {
    case 'event':      return thread.subjectId != null ? `/events/${thread.subjectId}` : null;
    case 'arena':      return thread.subjectId != null ? `/arenas/${thread.subjectId}` : null;
    case 'membership': return '/memberships';
    case 'general':    return null;
  }
}

const BOOKING_ITEM_LABELS: Record<QuestionContextBooking['itemType'], string> = {
  slot:       'Slot',
  event:      'Event',
  membership: 'Membership',
};

/** Translate API error codes into partner-friendly copy. */
function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'question_closed')   return 'This thread is closed — reopen it to reply.';
    if (e.code === 'question_archived') return 'This thread is archived — unarchive it first.';
    if (e.code === 'cannot_hide_root')  return 'The original question cannot be hidden.';
    if (e.code === 'not_public_thread') return 'Only replies on public threads can be hidden.';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

function MessageBubble({
  message,
  isRoot,
  isPublicThread,
  isArchivedThread,
  onModerate,
  moderating,
}: {
  message: QuestionMessage;
  isRoot: boolean;
  isPublicThread: boolean;
  isArchivedThread: boolean;
  onModerate: (messageId: string, action: 'hide' | 'unhide') => void;
  moderating: boolean;
}) {
  const { resolveTz } = useTimezone();
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

  const fromOrgSide = message.authorKind !== 'consumer';
  const hidden = message.hiddenAt != null;
  // The org can hide consumer replies on its public threads — never the root
  // question (server enforces both; this only controls where the button shows).
  // Archived threads reject moderation entirely (unarchive first).
  const canHide =
    isPublicThread && !isArchivedThread && !isRoot && message.authorKind === 'consumer' && !hidden;
  // The org can only undo its own hides; Circls hides are read-only here.
  const hiddenByCircls = hidden && message.hiddenByKind === 'circls';
  const canUnhide = hidden && !hiddenByCircls && !isArchivedThread;

  return (
    <div className={['flex flex-col', fromOrgSide ? 'items-end' : 'items-start'].join(' ')}>
      <div className="flex items-center gap-2 px-1 text-xs text-slate-400">
        <span className="font-medium text-slate-500">{message.authorName}</span>
        {message.authorKind === 'org' && <Badge tone="booked" label="You" />}
        {message.authorKind === 'circls' && <Badge tone="success" label="Circls" />}
        <span>{fmt.format(new Date(message.createdAt))}</span>
        {hidden && <Badge tone="neutral" label="Hidden" />}
      </div>
      <div
        className={[
          'mt-1 max-w-[85%] whitespace-pre-wrap rounded-[var(--radius)] px-3.5 py-2.5 text-sm sm:max-w-[70%]',
          fromOrgSide
            ? 'bg-brand-600 text-slate-900'
            : 'border border-[#e5e7eb] bg-slate-50 text-slate-800',
          hidden ? 'opacity-50' : '',
        ].join(' ')}
      >
        {message.body}
      </div>
      {(canHide || hidden) && (
        <div className="mt-0.5">
          {canHide && (
            <Button
              variant="ghost"
              size="sm"
              loading={moderating}
              onClick={() => onModerate(message.id, 'hide')}
            >
              Hide
            </Button>
          )}
          {canUnhide && (
            <Button
              variant="ghost"
              size="sm"
              loading={moderating}
              onClick={() => onModerate(message.id, 'unhide')}
            >
              Unhide
            </Button>
          )}
          {hiddenByCircls && (
            <span className="px-1 text-[11px] text-slate-400">
              Hidden by Circls — only the Circls team can unhide it
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Help-assistant interview transcript — what the customer picked before
 * this thread was created. Rendered as a muted preamble above the transcript.
 */
function InterviewAnswers({ answers }: { answers: QuestionFlowAnswer[] }) {
  return (
    <div className="rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        Interview answers
      </p>
      <dl className="mt-2 flex flex-col gap-2">
        {answers.map((fa, i) => (
          <div key={i}>
            <dt className="text-xs text-slate-500">{fa.question}</dt>
            <dd className="text-sm font-medium text-slate-800">{fa.answer}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-slate-400">
        What the customer picked in the Help assistant before this thread was created.
      </p>
    </div>
  );
}

function ContextSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      {children}
    </section>
  );
}

function bookingAmount(b: QuestionContextBooking): string {
  return b.totalPaise != null ? formatMoney(b.totalPaise, asCurrencyCode(b.currency)) : '—';
}

/**
 * Resolver context about the asker: who they are, the booking their support
 * request is about, and their history with this organisation. Tenant-scoped
 * server-side; contact details only arrive on private threads.
 */
function CustomerContext({
  tenantId,
  threadId,
  isPrivateThread,
}: {
  tenantId: string;
  threadId: string;
  isPrivateThread: boolean;
}) {
  const { data, isLoading, isError } = useQuestionContext(tenantId, threadId);
  const [collapsed, setCollapsed] = useState(false);
  const { resolveTz } = useTimezone();

  const fmtMonth = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: resolveTz(),
        year: 'numeric',
        month: 'long',
      }),
    [resolveTz],
  );
  const fmtDate = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: resolveTz(),
        year: 'numeric',
        month: 'short',
        day: '2-digit',
      }),
    [resolveTz],
  );
  const fmtDateTime = useMemo(
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

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-[#0f172a]">Customer context</h2>
        <Button variant="ghost" size="sm" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? 'Show' : 'Hide'}
        </Button>
      </div>

      {!collapsed && isLoading && (
        <p className="mt-3 text-sm text-slate-400">Loading&hellip;</p>
      )}
      {!collapsed && isError && (
        <p className="mt-3 text-sm text-slate-400">Customer context could not be loaded.</p>
      )}

      {!collapsed && data && (
        <div className="mt-3 flex flex-col gap-5">
          {/* Member */}
          <div>
            <p className="text-sm font-medium text-slate-900">{data.member.displayName}</p>
            <p className="text-xs text-slate-500">
              Member since {fmtMonth.format(new Date(data.member.memberSince))}
            </p>
            {data.member.email != null && data.member.email !== '' && (
              <p className="mt-1 break-all text-xs text-slate-600">{data.member.email}</p>
            )}
            {data.member.phone != null && data.member.phone !== '' && (
              <p className="mt-0.5 text-xs text-slate-600">{data.member.phone}</p>
            )}
            {!isPrivateThread && (
              <p className="mt-1 text-[11px] text-slate-400">
                Contact details are hidden on public questions.
              </p>
            )}
          </div>

          {/* Pinned booking (support intake) */}
          {data.contextBooking != null && (
            <ContextSection title="Booking in question">
              <div className="rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-slate-900">
                    {data.contextBooking.label}
                  </span>
                  <Badge
                    tone="neutral"
                    label={BOOKING_ITEM_LABELS[data.contextBooking.itemType]}
                  />
                  <StatusPill status={data.contextBooking.status} />
                </div>
                {data.contextBooking.timeRange != null && (
                  <p className="mt-1 text-xs text-slate-600">
                    {fmtDateTime.format(new Date(data.contextBooking.timeRange.start))}
                    {' – '}
                    {fmtDateTime.format(new Date(data.contextBooking.timeRange.end))}
                  </p>
                )}
                <p className="mt-1 text-xs text-slate-500">
                  {bookingAmount(data.contextBooking)}
                  {' · '}
                  {data.contextBooking.paymentMethod}
                  {' · booked '}
                  {fmtDate.format(new Date(data.contextBooking.createdAt))}
                </p>
              </div>
            </ContextSection>
          )}

          {/* Recent bookings */}
          <ContextSection title="Recent bookings">
            {data.recentBookings.length === 0 ? (
              <p className="text-xs text-slate-400">No bookings with your organisation.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <tbody className="divide-y divide-slate-100">
                  {data.recentBookings.map((b) => (
                    <tr key={b.id}>
                      <td className="max-w-0 py-1.5 pr-2" style={{ width: '55%' }}>
                        <p className="truncate text-slate-700">{b.label}</p>
                        <p className="text-[11px] text-slate-400">
                          {fmtDate.format(new Date(b.createdAt))}
                        </p>
                      </td>
                      <td className="py-1.5 pr-2">
                        <StatusPill status={b.status} />
                      </td>
                      <td className="whitespace-nowrap py-1.5 text-right text-slate-700">
                        {bookingAmount(b)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ContextSection>

          {/* Memberships */}
          <ContextSection title="Memberships">
            {data.memberships.length === 0 ? (
              <p className="text-xs text-slate-400">No memberships with your organisation.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {data.memberships.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-medium text-slate-700">{m.name}</span>
                    <StatusPill status={m.status} />
                    <span className="text-slate-400">
                      {fmtDate.format(new Date(m.startsAt))}
                      {' – '}
                      {fmtDate.format(new Date(m.endsAt))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ContextSection>

          {/* Prior threads */}
          <ContextSection title="Other threads">
            {data.priorThreads.length === 0 ? (
              <p className="text-xs text-slate-400">No other threads with your organisation.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {data.priorThreads.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Link
                      href={`/questions/${t.id}`}
                      className="font-medium text-slate-700 hover:text-brand-700 hover:underline"
                    >
                      {t.subject.name}
                    </Link>
                    {t.origin === 'support' && <Badge tone="support" label="Support" />}
                    <StatusPill status={t.status} />
                    <span className="text-slate-400">
                      {fmtDate.format(new Date(t.lastMessageAt))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </ContextSection>
        </div>
      )}
    </Card>
  );
}

function ThreadView({ tenantId, threadId }: { tenantId: string; threadId: string }) {
  const { data, isLoading, isError, error } = useQuestionThread(tenantId, threadId);
  const reply = useReplyToQuestion(tenantId, threadId);
  const setStatus = useSetQuestionStatus(tenantId, threadId);
  const moderate = useModerateQuestionMessage(tenantId, threadId);
  const archive = useArchiveQuestionThread(tenantId, threadId);

  const [body, setBody] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) {
    return <p className="py-6 text-center text-sm text-slate-400">Loading&hellip;</p>;
  }
  if (isError || !data) {
    return (
      <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
        Failed to load this question{error ? `: ${errorMessage(error)}` : '.'}
      </p>
    );
  }

  const { thread, messages } = data;
  const isClosed = thread.status === 'closed';
  const isArchived = thread.archivedAt != null;
  // The org can only undo its own archives; Circls archives are read-only here.
  const archivedByCircls = thread.archivedByKind === 'circls';
  const trimmed = body.trim();

  async function changeStatus(status: QuestionStatus) {
    setActionError(null);
    try {
      await setStatus.mutateAsync(status);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function handleArchive(action: 'archive' | 'unarchive') {
    setActionError(null);
    try {
      await archive.mutateAsync(action);
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function handleModerate(messageId: string, action: 'hide' | 'unhide') {
    setActionError(null);
    try {
      await moderate.mutateAsync({ messageId, action });
    } catch (e) {
      setActionError(errorMessage(e));
    }
  }

  async function handleReply(e: FormEvent) {
    e.preventDefault();
    if (!trimmed || trimmed.length > MAX_BODY) return;
    setReplyError(null);
    try {
      await reply.mutateAsync(trimmed);
      setBody('');
    } catch (err) {
      setReplyError(errorMessage(err));
    }
  }

  const href = subjectHref(thread);

  return (
    // Single column on small screens; on lg+ the customer-context panel moves
    // into a right-hand sidebar (aside below spans both content rows).
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
      <div className="flex flex-col gap-6 lg:col-start-1">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        {href != null ? (
          <Link
            href={href}
            className="text-lg font-semibold text-[#0f172a] hover:text-brand-700 hover:underline"
          >
            {thread.subject?.name ?? 'Listing'}
          </Link>
        ) : (
          // `general` support threads have no listing page to link to.
          <span className="text-lg font-semibold text-[#0f172a]">
            {thread.subject?.name ?? 'Listing'}
          </span>
        )}
        <Badge tone="neutral" label={SUBJECT_LABELS[thread.subjectType]} />
        {thread.origin === 'support' && <Badge tone="support" label="Support" />}
        {thread.origin === 'support' && thread.category != null && (
          <Badge tone="neutral" label={CATEGORY_LABELS[thread.category]} />
        )}
        {thread.visibility === 'public' ? (
          <Badge tone="booked" label="Public" />
        ) : (
          <Badge tone="held" label="Private" />
        )}
        <StatusPill status={thread.status} />
        {isArchived && <Badge tone="warning" label="Archived" />}
        <div className="ml-auto flex items-center gap-2">
          {/* Status changes are rejected on archived threads — unarchive first. */}
          {!isArchived && thread.status === 'open' && (
            <Button
              variant="secondary"
              size="sm"
              loading={setStatus.isPending}
              onClick={() => void changeStatus('answered')}
            >
              Mark answered
            </Button>
          )}
          {!isArchived && thread.status !== 'open' && (
            <Button
              variant="secondary"
              size="sm"
              loading={setStatus.isPending}
              onClick={() => void changeStatus('open')}
            >
              Reopen
            </Button>
          )}
          {!isArchived && !isClosed && (
            <Button
              variant="ghost"
              size="sm"
              disabled={setStatus.isPending}
              onClick={() => setConfirmClose(true)}
            >
              Close
            </Button>
          )}
          {!isArchived && (
            <Button
              variant="ghost"
              size="sm"
              disabled={archive.isPending}
              onClick={() => setConfirmArchive(true)}
            >
              Archive
            </Button>
          )}
        </div>
      </div>
      <p className="-mt-4 text-xs text-slate-400">
        Asked by {thread.authorName}
        {thread.visibility === 'public'
          ? ' · visible to everyone on the listing page'
          : ' · visible only to the asker, your team and Circls'}
      </p>

      {isArchived && (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-900">
              Archived — hidden from the customer
            </p>
            <p className="mt-0.5 text-xs text-amber-700">
              The customer (and everyone else outside your team and Circls) can no longer see
              this thread. Replies, status changes and moderation are off until it is unarchived.
            </p>
          </div>
          {archivedByCircls ? (
            <span className="whitespace-nowrap text-xs text-amber-700">
              Archived by Circls — only the Circls team can unarchive it
            </span>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={archive.isPending}
              onClick={() => void handleArchive('unarchive')}
            >
              Unarchive
            </Button>
          )}
        </div>
      )}

      {actionError && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {actionError}
        </p>
      )}
      </div>

      {/* Customer context — right sidebar on lg+, stacked before the transcript otherwise */}
      <aside className="lg:col-start-2 lg:row-start-1 lg:row-span-2">
        <CustomerContext
          tenantId={tenantId}
          threadId={threadId}
          isPrivateThread={thread.visibility === 'private'}
        />
      </aside>

      <div className="flex flex-col gap-6 lg:col-start-1">
      {/* Interview answers — Help-assistant intake transcript preamble */}
      {thread.flowAnswers != null && thread.flowAnswers.length > 0 && (
        <InterviewAnswers answers={thread.flowAnswers} />
      )}

      {/* Transcript */}
      <Card>
        <div className="flex flex-col gap-4">
          {messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              isRoot={i === 0}
              isPublicThread={thread.visibility === 'public'}
              isArchivedThread={isArchived}
              onModerate={(messageId, action) => void handleModerate(messageId, action)}
              moderating={moderate.isPending}
            />
          ))}
        </div>
      </Card>

      {/* Reply composer */}
      <Card title="Reply">
        {isArchived ? (
          <p className="text-sm text-slate-500">
            This thread is archived, so replies are off.
            {archivedByCircls
              ? ' Only the Circls team can unarchive it.'
              : ' Unarchive it above to reply.'}
          </p>
        ) : isClosed ? (
          <p className="text-sm text-slate-500">
            This thread is closed, so replies are off. <strong>Reopen</strong> it above to reply.
          </p>
        ) : (
          <form onSubmit={handleReply} className="flex flex-col gap-3">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your reply…"
              rows={4}
              maxLength={MAX_BODY}
              className="w-full resize-none rounded-[var(--radius)] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-400"
            />
            {replyError && <p className="text-sm text-red-600">{replyError}</p>}
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400">
                {body.length}/{MAX_BODY}
                {thread.status === 'open' && ' · replying marks this question answered'}
              </p>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={reply.isPending}
                disabled={!trimmed}
              >
                Send reply
              </Button>
            </div>
          </form>
        )}
      </Card>

      <ConfirmDialog
        open={confirmClose}
        title="Close this question?"
        message="Closing stops all further replies — the customer cannot reply to a closed thread. You can reopen it later if needed."
        confirmLabel="Close question"
        danger
        onConfirm={() => void changeStatus('closed')}
        onClose={() => setConfirmClose(false)}
      />

      <ConfirmDialog
        open={confirmArchive}
        title="Archive this thread?"
        message="Archiving hides the whole thread from the customer — it disappears from the listing page and from their questions, as if it never existed. Your team and Circls can still see it under the Archived tab, and you can unarchive it at any time."
        confirmLabel="Archive thread"
        danger
        onConfirm={() => void handleArchive('archive')}
        onClose={() => setConfirmArchive(false)}
      />
      </div>
    </div>
  );
}

export default function QuestionThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const { activeTenantId } = useOrg();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div>
        <Link
          href="/questions"
          className="text-sm text-slate-500 transition-colors hover:text-slate-800"
        >
          &larr; Questions
        </Link>
      </div>
      {!activeTenantId ? (
        <Card subtitle="Select or create an organization first to view its questions.">
          <p className="text-sm text-slate-500">
            No active organization. Use the switcher in the top bar to pick one.
          </p>
        </Card>
      ) : (
        <ThreadView tenantId={activeTenantId} threadId={threadId} />
      )}
    </div>
  );
}
