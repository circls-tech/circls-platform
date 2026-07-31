'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { useAskQuestion } from '@/lib/api/questions';
import { ApiError } from '@/lib/api/client';
import type {
  ListableQuestionSubjectType,
  QuestionThreadDetail,
  QuestionVisibility,
} from '@/lib/api/types';
import { Button, Modal } from '@/lib/ui';

const MAX_BODY = 2000;

const VISIBILITY_OPTIONS: { value: QuestionVisibility; label: string; detail: string }[] = [
  { value: 'public', label: 'Public', detail: 'Anyone can see and reply' },
  { value: 'private', label: 'Private', detail: 'Only you and the organiser' },
];

function askErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === 'question_rate_limited') {
    return 'You’ve reached the limit for new questions today — please try again tomorrow.';
  }
  return e instanceof Error ? e.message : 'Couldn’t post your question — please try again.';
}

/**
 * "Ask a question" modal for an event / court / membership. Signed-out users
 * get a sign-in prompt that redirects back here; signed-in users pick a
 * visibility and write the first message of the thread.
 */
export function AskQuestionModal({
  open,
  onClose,
  subjectType,
  subjectId,
  subjectName,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  subjectType: ListableQuestionSubjectType;
  subjectId: string;
  /** Shown as context above the form, e.g. the event name. */
  subjectName?: string;
  /** Called with the created thread so the caller can open it. */
  onCreated: (detail: QuestionThreadDetail) => void;
}) {
  const { user } = useAuth();
  const pathname = usePathname();
  const ask = useAskQuestion();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<QuestionVisibility>('public');

  const trimmed = body.trim();

  async function submit() {
    if (trimmed.length === 0 || ask.isPending) return;
    try {
      const detail = await ask.mutateAsync({ subjectType, subjectId, visibility, body: trimmed });
      setBody('');
      setVisibility('public');
      ask.reset();
      onCreated(detail);
    } catch {
      // Surfaced inline via ask.isError below; keep the draft for retry.
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Ask a question">
      {!user ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-ink">
            Sign in to ask the organiser a question
            {subjectName ? (
              <>
                {' '}about <span className="font-semibold">{subjectName}</span>
              </>
            ) : null}
            . You’ll come right back here.
          </p>
          <Link href={`/login?redirect=${encodeURIComponent(pathname)}`} onClick={onClose}>
            <Button variant="primary" size="sm">Sign in</Button>
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {subjectName && (
            <p className="text-sm text-text-secondary">
              About <span className="font-semibold text-ink">{subjectName}</span>
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="ask-question-body"
              className="font-display text-xs font-bold uppercase tracking-wide text-ink"
            >
              Your question
            </label>
            <textarea
              id="ask-question-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What would you like to know?"
              rows={4}
              maxLength={MAX_BODY}
              className="w-full rounded-[var(--radius)] border-[2px] border-ink bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-text-muted transition-colors duration-150 focus:border-coral-deep focus:outline-none"
            />
            <p className="text-right text-xs text-text-muted">
              {body.length}/{MAX_BODY}
            </p>
          </div>

          <div role="radiogroup" aria-label="Who can see this question" className="flex flex-col gap-2">
            <p className="font-display text-xs font-bold uppercase tracking-wide text-ink">
              Who can see it
            </p>
            {VISIBILITY_OPTIONS.map((opt) => {
              const selected = visibility === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setVisibility(opt.value)}
                  className={[
                    'flex w-full items-center justify-between gap-3 rounded-[var(--radius)] border-[2px] bg-white px-3.5 py-2.5 text-left transition-colors',
                    selected ? 'border-coral-deep bg-coral-soft/40' : 'border-ink hover:bg-surface-2',
                  ].join(' ')}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink">{opt.label}</span>
                    <span className="block text-xs text-text-secondary">{opt.detail}</span>
                  </span>
                  <span
                    aria-hidden
                    className={[
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[2px] border-ink',
                      selected ? 'bg-coral' : 'bg-white',
                    ].join(' ')}
                  />
                </button>
              );
            })}
          </div>

          {ask.isError && (
            <p className="text-sm font-semibold text-petal-red">{askErrorMessage(ask.error)}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={ask.isPending}
              disabled={trimmed.length === 0}
              onClick={() => void submit()}
            >
              Post question
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
