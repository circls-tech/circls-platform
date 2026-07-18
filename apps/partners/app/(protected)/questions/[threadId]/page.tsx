'use client';

import { type FormEvent, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { ApiError } from '@/lib/api/client';
import {
  useModerateQuestionMessage,
  useQuestionThread,
  useReplyToQuestion,
  useSetQuestionStatus,
} from '@/lib/api/questions';
import type {
  QuestionMessage,
  QuestionStatus,
  QuestionSubjectType,
  QuestionThreadDetailThread,
} from '@/lib/api/types';
import { Badge, Button, Card, StatusPill } from '@/lib/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';

const MAX_BODY = 2000;

const SUBJECT_LABELS: Record<QuestionSubjectType, string> = {
  event:      'Event',
  arena:      'Arena',
  membership: 'Membership',
};

/** Portal page for the thread's subject (memberships have no per-id page). */
function subjectHref(thread: QuestionThreadDetailThread): string {
  switch (thread.subjectType) {
    case 'event':      return `/events/${thread.subjectId}`;
    case 'arena':      return `/arenas/${thread.subjectId}`;
    case 'membership': return '/memberships';
  }
}

/** Translate API error codes into partner-friendly copy. */
function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'question_closed')   return 'This thread is closed — reopen it to reply.';
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
  onModerate,
  moderating,
}: {
  message: QuestionMessage;
  isRoot: boolean;
  isPublicThread: boolean;
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
  const canHide = isPublicThread && !isRoot && message.authorKind === 'consumer' && !hidden;
  // The org can only undo its own hides; Circls hides are read-only here.
  const hiddenByCircls = hidden && message.hiddenByKind === 'circls';
  const canUnhide = hidden && !hiddenByCircls;

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
            ? 'bg-brand-600 text-white'
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

function ThreadView({ tenantId, threadId }: { tenantId: string; threadId: string }) {
  const { data, isLoading, isError, error } = useQuestionThread(tenantId, threadId);
  const reply = useReplyToQuestion(tenantId, threadId);
  const setStatus = useSetQuestionStatus(tenantId, threadId);
  const moderate = useModerateQuestionMessage(tenantId, threadId);

  const [body, setBody] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
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
  const trimmed = body.trim();

  async function changeStatus(status: QuestionStatus) {
    setActionError(null);
    try {
      await setStatus.mutateAsync(status);
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

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={subjectHref(thread)}
          className="text-lg font-semibold text-[#0f172a] hover:text-brand-700 hover:underline"
        >
          {thread.subject?.name ?? 'Listing'}
        </Link>
        <Badge tone="neutral" label={SUBJECT_LABELS[thread.subjectType]} />
        {thread.visibility === 'public' ? (
          <Badge tone="booked" label="Public" />
        ) : (
          <Badge tone="held" label="Private" />
        )}
        <StatusPill status={thread.status} />
        <div className="ml-auto flex items-center gap-2">
          {thread.status === 'open' && (
            <Button
              variant="secondary"
              size="sm"
              loading={setStatus.isPending}
              onClick={() => void changeStatus('answered')}
            >
              Mark answered
            </Button>
          )}
          {thread.status !== 'open' && (
            <Button
              variant="secondary"
              size="sm"
              loading={setStatus.isPending}
              onClick={() => void changeStatus('open')}
            >
              Reopen
            </Button>
          )}
          {!isClosed && (
            <Button
              variant="ghost"
              size="sm"
              disabled={setStatus.isPending}
              onClick={() => setConfirmClose(true)}
            >
              Close
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

      {actionError && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {actionError}
        </p>
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
              onModerate={(messageId, action) => void handleModerate(messageId, action)}
              moderating={moderate.isPending}
            />
          ))}
        </div>
      </Card>

      {/* Reply composer */}
      <Card title="Reply">
        {isClosed ? (
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
    </div>
  );
}

export default function QuestionThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const { activeTenantId } = useOrg();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
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
