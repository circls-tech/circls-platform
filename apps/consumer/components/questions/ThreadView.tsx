'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMyProfile } from '@/lib/api/consumer';
import { useQuestionThread, useReplyToQuestion, useSetQuestionStatus } from '@/lib/api/questions';
import { ApiError } from '@/lib/api/client';
import type { QuestionMessageRow } from '@/lib/api/types';
import { formatRelativeTime } from '@/lib/format';
import { Button } from '@/lib/ui';
import { SlideOver } from './SlideOver';
import { QuestionStatusBadge } from './ThreadCard';

const MAX_BODY = 2000;

function replyErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'question_closed') return 'This thread has been closed — replies are off.';
    if (e.code === 'question_rate_limited') {
      return 'You’ve sent a lot of messages today — please try again later.';
    }
  }
  return e instanceof Error ? e.message : 'Couldn’t send that — please try again.';
}

/** Small inline author badge inside a bubble (Organizer / Circls). */
function AuthorTag({ kind }: { kind: 'org' | 'circls' }) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full border-[1.5px] border-ink px-1.5 py-px text-[10px] font-bold',
        kind === 'org' ? 'bg-coral text-ink' : 'bg-lav text-ink',
      ].join(' ')}
    >
      {kind === 'org' ? 'Organizer' : 'Circls'}
    </span>
  );
}

/**
 * A chat bubble. Consumers sit left on paper; org & Circls replies sit right
 * with their badge. The viewer's own messages (when they authored the thread)
 * are coral so they stand out from other consumers on public threads.
 */
function MessageBubble({ msg, own }: { msg: QuestionMessageRow; own: boolean }) {
  const staff = msg.authorKind === 'org' || msg.authorKind === 'circls';
  const hidden = msg.hiddenAt != null;
  return (
    <div className={staff ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={[
          'max-w-[85%] rounded-[var(--radius)] border-[2px] border-ink px-3 py-2 text-sm text-ink',
          msg.authorKind === 'org'
            ? 'bg-coral-soft'
            : msg.authorKind === 'circls'
              ? 'bg-lav-soft'
              : own
                ? 'bg-coral'
                : 'bg-surface-2',
          hidden ? 'opacity-60' : '',
        ].join(' ')}
      >
        <p className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-ink-soft">
          <span>{own ? 'You' : msg.authorName}</span>
          {staff && <AuthorTag kind={msg.authorKind as 'org' | 'circls'} />}
        </p>
        <p className="whitespace-pre-line break-words">{msg.body}</p>
        <p className="mt-1 text-[10px] text-ink-soft">
          {formatRelativeTime(msg.createdAt)}
          {hidden && ' · hidden by moderation'}
        </p>
      </div>
    </div>
  );
}

/**
 * Slide-over transcript of a question thread: chat bubbles, a reply composer,
 * and (for the asker) "Mark answered" / "Close thread" controls. Open while
 * `threadId` is set; the thread refetches every 30s in the background.
 */
export function ThreadView({
  threadId,
  onClose,
}: {
  threadId: string | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const pathname = usePathname();
  const threadQ = useQuestionThread(threadId);
  const profileQ = useMyProfile();
  const reply = useReplyToQuestion();
  const setStatus = useSetQuestionStatus();

  const [draft, setDraft] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const detail = threadQ.data;
  const thread = detail?.thread;
  const messages = detail?.messages ?? [];
  // The asker's DB id is on the thread; MyProfile carries the viewer's DB id
  // (Firebase uids don't match DB uuids, so this is the only sound comparison).
  const isAuthor = Boolean(thread && profileQ.data && thread.authorUserId === profileQ.data.id);
  const closed = thread?.status === 'closed';

  // Reset per-thread state whenever a different thread opens.
  useEffect(() => {
    setDraft('');
    setConfirmClose(false);
    reply.reset();
    setStatus.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const trimmed = draft.trim();

  async function send() {
    if (!threadId || trimmed.length === 0 || reply.isPending) return;
    try {
      await reply.mutateAsync({ threadId, body: trimmed });
      setDraft('');
    } catch {
      // Surfaced inline via reply.isError; keep the draft for retry.
    }
  }

  async function applyStatus(status: 'answered' | 'closed') {
    if (!threadId || setStatus.isPending) return;
    try {
      await setStatus.mutateAsync({ threadId, status });
      setConfirmClose(false);
    } catch {
      // Surfaced inline via setStatus.isError.
    }
  }

  return (
    <SlideOver
      open={threadId != null}
      onClose={onClose}
      ariaLabel="Question thread"
      title={
        <>
          <h2 className="truncate font-display text-lg font-extrabold text-ink">
            {thread?.subject.name || 'Question'}
          </h2>
          {thread && <QuestionStatusBadge status={thread.status} />}
        </>
      }
    >
      {thread?.visibility === 'private' && (
        <p className="border-b-[2px] border-ink/10 bg-lav-soft px-4 py-2 text-xs font-medium text-ink">
          Private — only you, the organiser and the Circls team can see this thread.
        </p>
      )}

      {/* Transcript */}
      <div ref={transcriptRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {threadQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading thread…</p>
        ) : threadQ.isError ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-petal-red">
              Couldn’t load this thread — it may have been removed
              {!user && ', or it’s private'}.
            </p>
            {!user && (
              <p className="text-sm text-ink">
                <Link
                  href={`/login?redirect=${encodeURIComponent(pathname)}`}
                  className="font-semibold text-coral-deep underline"
                >
                  Sign in
                </Link>{' '}
                if this is your question.
              </p>
            )}
          </div>
        ) : (
          messages.map((msg) => <MessageBubble key={msg.id} msg={msg} own={msg.own} />)
        )}
      </div>

      {/* Author controls + composer */}
      {thread && (
        <div className="flex flex-col gap-2.5 border-t-[2px] border-ink/10 px-4 py-3">
          {isAuthor && !closed && (
            <div className="flex flex-wrap items-center gap-2">
              {confirmClose ? (
                <>
                  <span className="text-xs font-medium text-ink">
                    Close this thread? Nobody can reply afterwards.
                  </span>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={setStatus.isPending}
                    onClick={() => void applyStatus('closed')}
                  >
                    Close it
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmClose(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  {thread.status === 'open' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={setStatus.isPending}
                      onClick={() => void applyStatus('answered')}
                    >
                      Mark answered
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setConfirmClose(true)}>
                    Close thread
                  </Button>
                </>
              )}
            </div>
          )}

          {setStatus.isError && (
            <p className="text-xs font-semibold text-petal-red">
              {setStatus.error instanceof Error
                ? setStatus.error.message
                : 'Couldn’t update the thread — please try again.'}
            </p>
          )}

          {closed ? (
            <p className="text-sm text-text-secondary">
              This thread is closed and can’t receive new replies.
              {isAuthor && ' If you still need help, ask a new question.'}
            </p>
          ) : !user ? (
            <p className="text-sm text-ink">
              <Link
                href={`/login?redirect=${encodeURIComponent(pathname)}`}
                className="font-semibold text-coral-deep underline"
              >
                Sign in
              </Link>{' '}
              to reply to this thread.
            </p>
          ) : (
            <>
              {reply.isError && (
                <p className="text-xs font-semibold text-petal-red">
                  {replyErrorMessage(reply.error)}
                </p>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Write a reply…"
                  rows={2}
                  maxLength={MAX_BODY}
                  aria-label="Reply"
                  className="w-full flex-1 rounded-[var(--radius)] border-[2px] border-ink bg-white px-3 py-2 text-sm text-ink placeholder:text-text-muted focus:border-coral-deep focus:outline-none"
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={reply.isPending}
                  disabled={trimmed.length === 0}
                  onClick={() => void send()}
                >
                  Send
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </SlideOver>
  );
}
