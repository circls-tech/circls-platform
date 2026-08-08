'use client';
import { type ReactNode, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { useFeedbackPrompt, useSubmitFeedback } from '@/lib/api/feedback';
import type { FeedbackPrompt } from '@/lib/api/types';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button, Modal } from '@/lib/ui';

/**
 * Post-login feedback prompt: once a consumer is signed in, the server decides
 * whether to ask "how was the event" (past registration) or one random
 * event-type multiple-choice question (no bookings yet), and this provider
 * surfaces it as a modal wherever the user landed. "Not now" is remembered per
 * prompt in localStorage (same persistence precedent as LocationProvider) so
 * we never nag about the same event / question twice on this device.
 */

const DISMISS_PREFIX = 'circls:feedback-dismissed:';

function dismissKey(uid: string, prompt: FeedbackPrompt): string {
  return prompt.kind === 'event_feedback'
    ? `${DISMISS_PREFIX}${uid}:event:${prompt.event.id}`
    : `${DISMISS_PREFIX}${uid}:pref`;
}

function isDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) != null;
  } catch {
    return false;
  }
}

function markDismissed(key: string): void {
  try {
    localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Storage unavailable (private mode) — worst case we ask again next visit.
  }
}

const RATING_LABELS = ['Terrible', 'Not great', 'Okay', 'Good', 'Loved it'];

export function FeedbackPromptProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const prompt = useFeedbackPrompt().data ?? null;
  const submit = useSubmitFeedback();

  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [answer, setAnswer] = useState('');
  const [thanks, setThanks] = useState(false);

  // Open when a fresh (non-dismissed) prompt arrives for the signed-in user;
  // reset the form whenever the prompt identity changes.
  const uid = user?.uid ?? null;
  const promptId = prompt ? dismissKey(uid ?? '', prompt) : null;
  useEffect(() => {
    setRating(0);
    setComment('');
    setAnswer('');
    setThanks(false);
    setOpen(Boolean(uid && promptId && !isDismissed(promptId)));
  }, [uid, promptId]);

  // Auto-close the little "thanks" state.
  useEffect(() => {
    if (!thanks) return;
    const t = setTimeout(() => setOpen(false), 1600);
    return () => clearTimeout(t);
  }, [thanks]);

  function dismiss() {
    if (promptId) markDismissed(promptId);
    setOpen(false);
  }

  async function send() {
    if (!prompt || submit.isPending) return;
    const input =
      prompt.kind === 'event_feedback'
        ? {
            kind: 'event_feedback' as const,
            eventId: prompt.event.id,
            rating,
            ...(comment.trim() ? { comment: comment.trim() } : {}),
          }
        : { kind: 'event_type_preference' as const, questionKey: prompt.question.key, answer };
    try {
      await submit.mutateAsync(input);
      setThanks(true);
    } catch (e) {
      // Already answered elsewhere (another tab/device) — nothing left to ask.
      if (e instanceof ApiError && e.code === 'feedback_exists') setOpen(false);
    }
  }

  const canSend = prompt?.kind === 'event_feedback' ? rating > 0 : answer.length > 0;

  return (
    <>
      {children}
      {prompt && (
        <Modal
          open={open}
          onClose={dismiss}
          title={
            thanks
              ? 'Thank you!'
              : prompt.kind === 'event_feedback'
                ? 'How was the event?'
                : 'Quick question'
          }
        >
          {thanks ? (
            <p className="text-sm text-ink">
              {prompt.kind === 'event_feedback'
                ? 'Thanks for the feedback — it helps organisers improve.'
                : 'Thanks! We’ll use this to bring better events to Circls.'}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {prompt.kind === 'event_feedback' ? (
                <>
                  <p className="text-sm text-text-secondary">
                    You went to{' '}
                    <span className="font-semibold text-ink">{prompt.event.name}</span>
                    {prompt.event.venueName ? ` at ${prompt.event.venueName}` : ''} — how was it?
                  </p>
                  <div
                    role="radiogroup"
                    aria-label="Rate the event"
                    className="flex items-center gap-1.5"
                  >
                    {RATING_LABELS.map((label, i) => {
                      const value = i + 1;
                      const filled = value <= rating;
                      return (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={rating === value}
                          aria-label={`${value} star${value === 1 ? '' : 's'} — ${label}`}
                          onClick={() => setRating(value)}
                          className={[
                            'flex h-10 w-10 items-center justify-center rounded-[var(--radius)] border-[2px] text-xl transition-colors',
                            filled
                              ? 'border-coral-deep bg-coral-soft/40 text-coral-deep'
                              : 'border-ink bg-white text-text-muted hover:bg-surface-2',
                          ].join(' ')}
                        >
                          ★
                        </button>
                      );
                    })}
                    {rating > 0 && (
                      <span className="ml-2 text-sm font-semibold text-ink">
                        {RATING_LABELS[rating - 1]}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="event-feedback-comment"
                      className="font-display text-xs font-bold uppercase tracking-wide text-ink"
                    >
                      Anything else? (optional)
                    </label>
                    <textarea
                      id="event-feedback-comment"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="What stood out, what could be better…"
                      rows={3}
                      maxLength={2000}
                      className="w-full rounded-[var(--radius)] border-[2px] border-ink bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-text-muted transition-colors duration-150 focus:border-coral-deep focus:outline-none"
                    />
                  </div>
                </>
              ) : (
                <div
                  role="radiogroup"
                  aria-label={prompt.question.question}
                  className="flex flex-col gap-2"
                >
                  <p className="text-sm text-ink">{prompt.question.question}</p>
                  {prompt.question.options.map((opt) => {
                    const selected = answer === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setAnswer(opt)}
                        className={[
                          'flex w-full items-center justify-between gap-3 rounded-[var(--radius)] border-[2px] bg-white px-3.5 py-2.5 text-left transition-colors',
                          selected ? 'border-coral-deep bg-coral-soft/40' : 'border-ink hover:bg-surface-2',
                        ].join(' ')}
                      >
                        <span className="text-sm font-semibold text-ink">{opt}</span>
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
              )}

              {submit.isError && !(submit.error instanceof ApiError && submit.error.code === 'feedback_exists') && (
                <p className="text-sm font-semibold text-petal-red">
                  Couldn’t send your answer — please try again.
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  Not now
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={submit.isPending}
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  {prompt.kind === 'event_feedback' ? 'Send feedback' : 'Submit'}
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
