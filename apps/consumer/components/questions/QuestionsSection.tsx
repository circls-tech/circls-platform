'use client';
import { useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMyQuestions, usePublicQuestions } from '@/lib/api/questions';
import type { ListableQuestionSubjectType, QuestionThreadDetail } from '@/lib/api/types';
import { Button } from '@/lib/ui';
import { AskQuestionModal } from './AskQuestionModal';
import { ThreadCard } from './ThreadCard';
import { ThreadView } from './ThreadView';

/**
 * Inline "Questions" section for an event / court / membership detail page:
 * the signed-in user's own threads on this subject (public + private), the
 * public thread list, and an "Ask a question" entry point. Threads open in a
 * right slide-over; "Show more" pages through with the cursor.
 */
export function QuestionsSection({
  subjectType,
  subjectId,
  subjectName,
  showHeading = true,
}: {
  subjectType: ListableQuestionSubjectType;
  subjectId: string;
  /** Context shown in the ask modal, e.g. the event name. */
  subjectName?: string;
  /** Hide the "Questions" heading when the section already sits under one. */
  showHeading?: boolean;
}) {
  const { user } = useAuth();
  const publicQ = usePublicQuestions(subjectType, subjectId);
  const mineQ = useMyQuestions({ subjectType, subjectId });
  const [askOpen, setAskOpen] = useState(false);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  const mineRows = mineQ.data?.pages.flatMap((p) => p.rows) ?? [];
  // The user's public threads already show in their own strip — don't repeat them.
  const mineIds = new Set(mineRows.map((r) => r.id));
  const publicRows = (publicQ.data?.pages.flatMap((p) => p.rows) ?? []).filter(
    (r) => !mineIds.has(r.id),
  );

  function onCreated(detail: QuestionThreadDetail) {
    setAskOpen(false);
    setOpenThreadId(detail.thread.id);
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        {showHeading ? (
          <h2 className="font-display text-xl font-extrabold text-ink">Questions</h2>
        ) : (
          <span />
        )}
        <Button variant="secondary" size="sm" onClick={() => setAskOpen(true)}>
          Ask a question
        </Button>
      </div>

      {user && mineRows.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-ink-soft">
            Your questions
          </p>
          <div className="flex flex-col gap-2.5">
            {mineRows.map((row) => (
              <ThreadCard key={row.id} row={row} onOpen={() => setOpenThreadId(row.id)} />
            ))}
          </div>
          {mineQ.hasNextPage && (
            <button
              type="button"
              onClick={() => void mineQ.fetchNextPage()}
              disabled={mineQ.isFetchingNextPage}
              className="mt-2 text-xs font-semibold text-coral-deep underline disabled:opacity-50"
            >
              {mineQ.isFetchingNextPage ? 'Loading…' : 'Show more of yours'}
            </button>
          )}
        </div>
      )}

      {publicQ.isLoading ? (
        <p className="text-sm text-text-secondary">Loading questions…</p>
      ) : publicQ.isError ? (
        <p className="text-sm font-semibold text-petal-red">
          {publicQ.error instanceof Error ? publicQ.error.message : 'Failed to load questions'}
        </p>
      ) : publicRows.length === 0 ? (
        mineRows.length === 0 && (
          <p className="text-sm text-text-secondary">
            No questions yet — be the first to ask the organiser.
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2.5">
          {publicRows.map((row) => (
            <ThreadCard key={row.id} row={row} onOpen={() => setOpenThreadId(row.id)} />
          ))}
        </div>
      )}

      {publicQ.hasNextPage && (
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            loading={publicQ.isFetchingNextPage}
            onClick={() => void publicQ.fetchNextPage()}
          >
            Show more
          </Button>
        </div>
      )}

      <AskQuestionModal
        open={askOpen}
        onClose={() => setAskOpen(false)}
        subjectType={subjectType}
        subjectId={subjectId}
        subjectName={subjectName}
        onCreated={onCreated}
      />
      <ThreadView threadId={openThreadId} onClose={() => setOpenThreadId(null)} />
    </div>
  );
}
