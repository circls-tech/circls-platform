'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApiError } from '@/lib/api/client';
import {
  useAdminQuestionThread,
  useAdminReplyToQuestion,
  useArchiveAdminQuestion,
  useHideQuestionMessage,
  useUnhideQuestionMessage,
  useUpdateAdminQuestion,
} from '@/lib/api/queries';
import type { QuestionMessageRow, QuestionStatus } from '@/lib/api/types';
import {
  AUTHOR_KIND_COLORS,
  AUTHOR_KIND_LABELS,
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
import { CustomerContextPanel } from './context_panel';

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'question_closed') return 'This thread is closed — reopen it before replying.';
    if (err.code === 'question_archived') return 'This thread is archived — unarchive it first.';
    if (err.code === 'not_public_thread') return 'Moderation is only available on public threads.';
    return err.message;
  }
  return fallback;
}

function MessageBubble({
  message,
  isPublicThread,
  isArchivedThread,
  threadId,
}: {
  message: QuestionMessageRow;
  isPublicThread: boolean;
  isArchivedThread: boolean;
  threadId: string;
}) {
  const hide = useHideQuestionMessage();
  const unhide = useUnhideQuestionMessage();
  const [modError, setModError] = useState<string | null>(null);

  const fromStaff = message.authorKind !== 'consumer';
  const hidden = message.hiddenAt !== null;
  const pending = hide.isPending || unhide.isPending;

  async function toggleHidden() {
    setModError(null);
    try {
      if (hidden) {
        await unhide.mutateAsync({ threadId, messageId: message.id });
      } else {
        if (!window.confirm('Hide this message from public view?')) return;
        await hide.mutateAsync({ threadId, messageId: message.id });
      }
    } catch (err) {
      setModError(errorText(err, 'Moderation action failed.'));
    }
  }

  return (
    <div className={`flex ${fromStaff ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[75%] rounded-lg border px-3 py-2',
          fromStaff ? 'border-indigo-100 bg-indigo-50' : 'border-slate-200 bg-white',
          hidden ? 'opacity-50' : '',
        ].join(' ')}
      >
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-700">{message.authorName}</span>
          <Badge
            label={AUTHOR_KIND_LABELS[message.authorKind]}
            tone={AUTHOR_KIND_COLORS[message.authorKind]}
          />
          {hidden && (
            <Badge
              label={message.hiddenByKind === 'org' ? 'Hidden by org' : 'Hidden by Circls'}
              tone="bg-rose-100 text-rose-800"
            />
          )}
        </div>
        <p className="whitespace-pre-line text-sm text-slate-800">{message.body}</p>
        <div className="mt-1 flex items-center gap-3">
          <span className="text-[10px] text-slate-400">
            {IST_FMT.format(new Date(message.createdAt))}
          </span>
          {/* Archived threads reject moderation (409) — unarchive first. */}
          {isPublicThread && !isArchivedThread && (
            <button
              type="button"
              onClick={() => void toggleHidden()}
              disabled={pending}
              className="text-[10px] font-medium text-indigo-600 hover:underline disabled:opacity-50"
            >
              {pending ? 'Working…' : hidden ? 'Unhide' : 'Hide'}
            </button>
          )}
        </div>
        {modError && <p className="mt-1 text-xs text-red-600">{modError}</p>}
      </div>
    </div>
  );
}

export default function QuestionThreadPage() {
  const params = useParams<{ threadId: string }>();
  const threadId = params.threadId;

  const { data, isLoading, isError, error } = useAdminQuestionThread(threadId);
  const reply = useAdminReplyToQuestion();
  const updateStatus = useUpdateAdminQuestion();
  const archiveThread = useArchiveAdminQuestion();

  const [body, setBody] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="space-y-3">
        <Link href="/questions" className="text-sm text-slate-500 hover:text-slate-800">
          &larr; Questions
        </Link>
        <p className="text-sm text-red-600">
          Failed to load thread: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      </div>
    );
  }

  const t = data.thread;
  const isClosed = t.status === 'closed';
  const isPublicThread = t.visibility === 'public';
  const isArchived = t.archivedAt !== null;
  const trimmed = body.trim();

  async function handleStatusChange(next: QuestionStatus) {
    setStatusError(null);
    try {
      await updateStatus.mutateAsync({ threadId, status: next });
    } catch (err) {
      setStatusError(errorText(err, 'Failed to update status.'));
    }
  }

  async function handleArchiveToggle() {
    setArchiveError(null);
    if (
      !isArchived &&
      !window.confirm(
        'Archive this thread? It disappears from all consumer surfaces (the asker included) until it is unarchived.',
      )
    ) {
      return;
    }
    try {
      await archiveThread.mutateAsync({
        threadId,
        action: isArchived ? 'unarchive' : 'archive',
      });
    } catch (err) {
      setArchiveError(errorText(err, 'Failed to update the archive state.'));
    }
  }

  async function handleReply() {
    if (!trimmed || trimmed.length > 2000) return;
    setReplyError(null);
    try {
      await reply.mutateAsync({ threadId, body: trimmed });
      setBody('');
    } catch (err) {
      setReplyError(errorText(err, 'Failed to send reply.'));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/questions" className="text-sm text-slate-500 hover:text-slate-800">
          &larr; Questions
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-slate-900">
            {t.subjectType === 'general'
              ? 'General question'
              : t.subject.name
                ? `Question on ${t.subject.name}`
                : `Question on ${SUBJECT_TYPE_LABELS[t.subjectType].toLowerCase()}`}
          </h1>
          {t.origin === 'support' && (
            <Badge label={ORIGIN_LABELS.support} tone={ORIGIN_COLORS.support} />
          )}
          {t.category && (
            <Badge label={CATEGORY_LABELS[t.category]} tone="bg-slate-100 text-slate-700" />
          )}
          <Badge label={SUBJECT_TYPE_LABELS[t.subjectType]} tone={SUBJECT_TYPE_COLORS[t.subjectType]} />
          <Badge label={VISIBILITY_LABELS[t.visibility]} tone={VISIBILITY_COLORS[t.visibility]} />
          <Badge label={STATUS_LABELS[t.status]} tone={STATUS_COLORS[t.status]} />
          {isArchived && <Badge label="Archived" tone="bg-amber-100 text-amber-800" />}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-4 text-xs text-slate-500">
          <span>Asked by {t.authorName}</span>
          {t.subjectId && (
            <span>
              Subject <span className="font-mono">{t.subjectId}</span>
            </span>
          )}
          <span>
            Tenant{' '}
            <Link href={`/tenants/${t.tenantId}`} className="font-mono text-blue-700 hover:underline">
              {t.tenantId.slice(0, 8)}…
            </Link>
          </span>
          <span>Asked {IST_FMT.format(new Date(t.createdAt))} IST</span>
        </div>
      </div>

      {isArchived && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            Archived — hidden from consumers
            {t.archivedByKind === 'circls' ? ' (archived by Circls)' : ' (archived by the org)'}
          </p>
          <p className="mt-0.5 text-xs text-amber-700">
            The thread is invisible on every consumer surface, the asker&apos;s included. Replies,
            status changes and moderation are rejected until it is unarchived.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="thread-status" className="text-xs font-medium text-slate-500">
          Status
        </label>
        <select
          id="thread-status"
          value={t.status}
          onChange={(e) => void handleStatusChange(e.target.value as QuestionStatus)}
          disabled={updateStatus.isPending || isArchived}
          className={[
            'rounded px-2 py-1 text-xs font-medium border-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60',
            STATUS_COLORS[t.status],
          ].join(' ')}
        >
          {(Object.keys(STATUS_LABELS) as QuestionStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        {statusError && <p className="text-xs text-red-600">{statusError}</p>}
        <button
          type="button"
          onClick={() => void handleArchiveToggle()}
          disabled={archiveThread.isPending}
          className={[
            'ml-auto rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50',
            isArchived
              ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              : 'border-amber-200 bg-white text-amber-700 hover:bg-amber-50',
          ].join(' ')}
        >
          {archiveThread.isPending ? 'Working…' : isArchived ? 'Unarchive' : 'Archive'}
        </button>
        {archiveError && <p className="text-xs text-red-600">{archiveError}</p>}
      </div>

      {/* Resolver context about the asker (member, bookings, history …). */}
      <CustomerContextPanel threadId={threadId} />

      {/* Support-intake interview transcript (support-origin threads only). */}
      {t.flowAnswers && t.flowAnswers.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Interview answers
          </h2>
          <ol className="space-y-1.5">
            {t.flowAnswers.map((a, i) => (
              <li key={i} className="text-xs text-slate-600">
                <span className="text-slate-500">{a.question}</span>
                <span className="mx-1 text-slate-400">→</span>
                <span className="font-medium text-slate-800">{a.answer}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Transcript */}
      <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/50 p-4">
        {data.messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            isPublicThread={isPublicThread}
            isArchivedThread={isArchived}
            threadId={threadId}
          />
        ))}
      </div>

      {/* Reply composer */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <label htmlFor="reply-body" className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-500">
          Reply as Circls
        </label>
        <textarea
          id="reply-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={isArchived || isClosed || reply.isPending}
          rows={3}
          maxLength={2000}
          placeholder={
            isArchived ? 'Thread is archived.' : isClosed ? 'Thread is closed.' : 'Write a reply…'
          }
          className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-400 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-400">
            {isArchived ? (
              <span className="text-slate-500">
                This thread is archived — unarchive it to reply.
              </span>
            ) : isClosed ? (
              <span className="text-slate-500">
                This thread is closed — set status to Open or Answered to reply.
              </span>
            ) : (
              <span>{trimmed.length}/2000</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleReply()}
            disabled={isArchived || isClosed || reply.isPending || trimmed.length === 0}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {reply.isPending ? 'Sending…' : 'Send reply'}
          </button>
        </div>
        {replyError && <p className="mt-2 text-sm text-red-600">{replyError}</p>}
      </div>
    </div>
  );
}
