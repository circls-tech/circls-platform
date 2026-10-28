'use client';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { useDismissFeedback, useFeedbackPrompt, useSubmitFeedback } from '@/lib/api/feedback';
import { useCheckoutModal } from '@/lib/checkout/CheckoutProvider';
import type { FeedbackPrompt, RatingKind, SubmitFeedbackInput } from '@/lib/api/types';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button, Modal } from '@/lib/ui';
import { NOT_TRIED, NoteField, RatingScale, type ScaleValue, scaleToRating } from './RatingScale';

/**
 * Feedback prompts: once a consumer is signed in, the server decides what to
 * ask (see feedback_service) — a 1–10 rating of something they booked, the
 * event-type poll, or the website survey — and this provider surfaces it.
 *
 *  - Ratings and the poll open as a modal a moment after the page loads.
 *  - The website survey is a nudge: a small card on the home, search and
 *    account pages (never over a detail page's booking bar) that opens the
 *    survey when they choose to.
 *
 * "Not now" is recorded server-side: a rating or the poll is not asked again,
 * the website survey comes back a week later on any device. Closing the modal
 * (the X, the backdrop, Escape) only puts it away for this visit. At most one
 * prompt is handled per browser session and account, so answering one never
 * chains straight into the next — and none opens once a checkout has, so a
 * purchase is never interrupted (signing in mid-booking resumes checkout).
 */

const HANDLED_KEY = 'circls:feedback-handled';
/** Pages where a prompt would interrupt something. */
const QUIET_PATHS = ['/login', '/account'];
/** Pages with room for the website nudge card (no sticky booking bar). */
function nudgePath(pathname: string): boolean {
  return pathname === '/' || pathname === '/search' || pathname === '/help' || pathname.startsWith('/me');
}
const OPEN_DELAY_MS = 1500;

function handledThisSession(uid: string): boolean {
  try {
    return sessionStorage.getItem(`${HANDLED_KEY}:${uid}`) != null;
  } catch {
    return false;
  }
}

function markHandled(uid: string | null): void {
  if (!uid) return;
  try {
    sessionStorage.setItem(`${HANDLED_KEY}:${uid}`, '1');
  } catch {
    // Storage unavailable (private mode) — the server-side dismissal still holds.
  }
}

const DATE = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

const RATING_TITLE: Record<RatingKind, (name: string) => string> = {
  event_feedback: (name) => `How was ${name}?`,
  venue_feedback: (name) => `How was your visit to ${name}?`,
  // Asked while it runs or the day after a short pass ends: "been" fits both.
  membership_feedback: (name) => `How's your ${name} membership been?`,
};

function title(prompt: FeedbackPrompt): string {
  switch (prompt.kind) {
    case 'event_type_preference':
      return 'Quick question';
    case 'site_feedback':
      return 'How’s Circls working for you?';
    default:
      return RATING_TITLE[prompt.kind](prompt.subject.name);
  }
}

export function FeedbackPromptProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname() ?? '/';
  const live = useFeedbackPrompt().data ?? null;
  const submit = useSubmitFeedback();
  const dismissMutation = useDismissFeedback();

  // The prompt on screen. Held apart from the query so that answering, which
  // refetches the next prompt, doesn't swap or pull it away mid-"thanks".
  const [prompt, setPrompt] = useState<FeedbackPrompt | null>(null);
  const [open, setOpen] = useState(false);
  const [thanks, setThanks] = useState(false);
  // Starts true so nothing flashes before sessionStorage has been read.
  const [handled, setHandled] = useState(true);
  // Rating / poll answers.
  const [rating, setRating] = useState<ScaleValue>(null);
  const [comment, setComment] = useState('');
  const [answer, setAnswer] = useState('');
  const [other, setOther] = useState('');
  // Website survey answers.
  const [overall, setOverall] = useState<ScaleValue>(null);
  const [discovery, setDiscovery] = useState<ScaleValue>(null);
  const [booking, setBooking] = useState<ScaleValue>(null);
  const [challenges, setChallenges] = useState('');
  const [comments, setComments] = useState('');

  const uid = user?.uid ?? null;
  useEffect(() => {
    setHandled(uid ? handledThisSession(uid) : true);
    setPrompt(null);
    setOpen(false);
  }, [uid]);

  // A checkout opening (by hand, or resumed after signing in) ends prompting
  // for this session: nothing pops up over, or straight after, a purchase.
  const { isOpen: checkoutOpen } = useCheckoutModal();
  useEffect(() => {
    if (!checkoutOpen || handled) return;
    markHandled(uid);
    setHandled(true);
    setPrompt(null);
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to checkout opening
  }, [checkoutOpen]);

  // Take up what the server asks, with a fresh form — until one prompt has
  // been handled this session. Never swapped while one is open: a refetch
  // mid-answer (e.g. on reconnect) must not throw away what they typed.
  useEffect(() => {
    if (handled || open) return;
    if (!live) {
      setPrompt(null);
      setOpen(false);
      return;
    }
    if (prompt?.key === live.key) return;
    setPrompt(live);
    setOpen(false);
    setRating(null);
    setComment('');
    setAnswer('');
    setOther('');
    setOverall(null);
    setDiscovery(null);
    setBooking(live.kind === 'site_feedback' && !live.hasBooked ? NOT_TRIED : null);
    setChallenges('');
    setComments('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the prompt's identity
  }, [handled, open, live?.key]);

  // Ratings and the poll open by themselves, a moment after the page settles;
  // never on quiet pages.
  const quiet = QUIET_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const modalKind = prompt != null && prompt.kind !== 'site_feedback';
  useEffect(() => {
    if (!modalKind || handled || quiet) return;
    const t = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
    return () => clearTimeout(t);
  }, [modalKind, prompt?.key, handled, quiet]);
  const nudge =
    prompt?.kind === 'site_feedback' && !handled && !open && !quiet && nudgePath(pathname);

  /** Put it away for this visit; nothing is recorded server-side. */
  function close() {
    setOpen(false);
    setThanks(false);
    setPrompt(null);
    markHandled(uid);
    setHandled(true);
  }

  // Auto-close the little "thanks" state.
  useEffect(() => {
    if (!thanks) return;
    const t = setTimeout(close, 1800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close only sets state and the session flag
  }, [thanks]);

  function dismiss() {
    if (prompt && !thanks) dismissMutation.mutate(prompt.key);
    close();
  }

  async function send() {
    if (!prompt || submit.isPending) return;
    let input: SubmitFeedbackInput;
    if (prompt.kind === 'event_type_preference') {
      input = {
        kind: 'event_type_preference',
        questionKey: prompt.question.key,
        answer,
        ...(answer === prompt.question.otherOption ? { other: other.trim() } : {}),
      };
    } else if (prompt.kind === 'site_feedback') {
      input = {
        kind: 'site_feedback',
        overallRating: scaleToRating(overall) ?? 0,
        discoveryRating: scaleToRating(discovery),
        bookingRating: scaleToRating(booking),
        ...(challenges.trim() ? { challenges: challenges.trim() } : {}),
        ...(comments.trim() ? { comments: comments.trim() } : {}),
      };
    } else {
      input = {
        kind: prompt.kind,
        id: prompt.subject.id,
        rating: scaleToRating(rating) ?? 0,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      };
    }
    try {
      await submit.mutateAsync(input);
      // Handled before the refetch lands, so the next prompt waits for a new session.
      markHandled(uid);
      setHandled(true);
      setThanks(true);
    } catch (e) {
      // Already answered elsewhere (another tab/device) — nothing left to ask.
      if (e instanceof ApiError && (e.code === 'feedback_exists' || e.code === 'feedback_not_eligible')) {
        close();
      }
    }
  }

  const canSend =
    prompt?.kind === 'event_type_preference'
      ? answer.length > 0 && (answer !== prompt.question.otherOption || other.trim().length > 0)
      : prompt?.kind === 'site_feedback'
        ? typeof overall === 'number'
        : typeof rating === 'number';

  const sendError =
    submit.isError &&
    !(submit.error instanceof ApiError && ['feedback_exists', 'feedback_not_eligible'].includes(submit.error.code ?? ''));

  return (
    <>
      {children}
      {nudge && (
        <div
          role="region"
          aria-label="Feedback"
          className="fixed inset-x-4 bottom-4 z-30 rounded-[var(--radius-card)] border-[2px] border-ink bg-white p-4 shadow-offset [margin-bottom:env(safe-area-inset-bottom)] sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-80"
        >
          <p className="font-display text-sm font-extrabold text-ink">Got a minute?</p>
          <p className="mt-1 text-sm text-text-secondary">
            Tell us how Circls is working for you — it takes about a minute.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Not now
            </Button>
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              Share feedback
            </Button>
          </div>
        </div>
      )}
      {prompt && (
        <Modal open={open} onClose={close} title={thanks ? 'Thank you!' : title(prompt)}>
          {thanks ? (
            <p className="text-sm text-ink">
              {prompt.kind === 'event_type_preference'
                ? 'Thanks! We’ll use this to bring better events to Circls.'
                : prompt.kind === 'site_feedback'
                  ? 'Thanks — every answer is read by the Circls team.'
                  : `Thanks — this helps ${prompt.subject.orgName} and Circls get better.`}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Padded inside so the last field's border and focus ring aren't clipped by the scroll edge. */}
              <div className="-mx-1 -mb-1 flex max-h-[65vh] flex-col gap-4 overflow-y-auto px-1 pb-1">
                {prompt.kind === 'event_type_preference' ? (
                  <div role="radiogroup" aria-label={prompt.question.question} className="flex flex-col gap-2">
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
                    {answer === prompt.question.otherOption && (
                      <input
                        type="text"
                        autoFocus
                        aria-label="What kind of event?"
                        value={other}
                        onChange={(e) => setOther(e.target.value)}
                        placeholder="e.g. Pottery classes, trivia nights…"
                        maxLength={200}
                        className="w-full rounded-[var(--radius)] border-[2px] border-ink bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-text-muted transition-colors duration-150 focus:border-coral-deep focus:outline-none"
                      />
                    )}
                  </div>
                ) : prompt.kind === 'site_feedback' ? (
                  <>
                    <p className="text-sm text-text-secondary">
                      A few quick questions about the website. Only the first one is required.
                    </p>
                    <RatingScale
                      label="Overall, how easy is Circls to use?"
                      value={overall}
                      onChange={setOverall}
                      low="Very hard"
                      high="Very easy"
                    />
                    <RatingScale
                      label="Finding things to do"
                      value={discovery}
                      onChange={setDiscovery}
                      low="Very hard"
                      high="Very easy"
                      notTriedLabel="Haven’t tried"
                    />
                    <RatingScale
                      label="Booking and paying"
                      value={booking}
                      onChange={setBooking}
                      low="Very hard"
                      high="Very easy"
                      notTriedLabel="Haven’t booked"
                    />
                    <NoteField
                      id="site-feedback-challenges"
                      label="Any challenges you faced? (optional)"
                      value={challenges}
                      onChange={setChallenges}
                      placeholder="Something confusing, slow or missing…"
                    />
                    <NoteField
                      id="site-feedback-comments"
                      label="Anything else? (optional)"
                      value={comments}
                      onChange={setComments}
                      placeholder="Ideas, wishes, kind words…"
                    />
                  </>
                ) : (
                  <>
                    <p className="text-sm text-text-secondary">
                      <span className="font-semibold text-ink">{prompt.subject.orgName}</span>
                      {prompt.subject.place ? ` · ${prompt.subject.place}` : ''}
                      {prompt.subject.date ? ` · ${DATE.format(new Date(prompt.subject.date))}` : ''}
                    </p>
                    <RatingScale label="Rate it from 1 to 10" value={rating} onChange={setRating} />
                    <NoteField
                      id="rating-feedback-comment"
                      label="Anything you’d like to add? (optional)"
                      value={comment}
                      onChange={setComment}
                      placeholder="What stood out, what could be better…"
                    />
                  </>
                )}
              </div>

              {sendError && (
                <p className="text-sm font-semibold text-petal-red">Couldn’t send your answer — please try again.</p>
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
                  Send
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
