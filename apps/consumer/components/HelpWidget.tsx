'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMyBookings } from '@/lib/api/consumer';
import { useSubmitSupportThread } from '@/lib/api/questions';
import { ApiError } from '@/lib/api/client';
import type { MyBooking } from '@/lib/api/types';
import { ThreadView } from '@/components/questions/ThreadView';
import { Button } from '@/lib/ui';
import { helpFlow } from '@/lib/help/flows';
import {
  buildSubmission,
  chooseBooking,
  chooseOption,
  currentNode,
  startFlow,
  submitFreeText,
  type FlowState,
} from '@/lib/help/engine';

function bookingLabel(b: MyBooking): string {
  const when = new Date(b.createdAt).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  // Cancelled bookings stay pickable (refund concerns are about them) but are
  // marked so users know what they're attaching.
  const cancelled = b.status === 'cancelled' ? ' (cancelled)' : '';
  return `${b.venueName} · ${b.itemType} · ${when}${cancelled}`;
}

/** A single chat bubble — bot (left, surface) or user (right, coral). */
function Bubble({ from, children }: { from: 'bot' | 'user'; children: React.ReactNode }) {
  const isBot = from === 'bot';
  return (
    <div className={isBot ? 'flex justify-start' : 'flex justify-end'}>
      <div
        className={[
          'max-w-[85%] rounded-[var(--radius)] border-[2px] border-ink px-3 py-2 text-sm',
          isBot ? 'bg-surface-2 text-ink' : 'bg-coral text-ink',
        ].join(' ')}
      >
        {children}
      </div>
    </div>
  );
}

type Phase = 'flow' | 'submitting' | 'done';

/** Friendly transcript copy for a failed support-thread submission. */
function submitErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'question_rate_limited') {
      return 'You’ve started quite a few conversations today — please try again a little later.';
    }
    if (e.code === 'booking_not_found') {
      return 'We couldn’t find that booking on your account. Tap “Start over” and pick a different booking (or skip the picker).';
    }
  }
  return 'Couldn’t send that — please try again.';
}

function HelpConversation({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<FlowState>(() => startFlow(helpFlow));
  const [phase, setPhase] = useState<Phase>('flow');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [text, setText] = useState('');

  const submit = useSubmitSupportThread();
  const node = currentNode(helpFlow, state);

  // A failed submission appends an error bubble at the transcript's tail —
  // make sure it's actually on screen (long interviews scroll it out of view).
  const errorRef = useRef<HTMLDivElement>(null);
  const showError = phase === 'flow' && submit.isError;
  useEffect(() => {
    if (showError) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showError]);

  // Bookings are only needed once we reach a picker; fetch lazily but harmlessly.
  const needsBookings = node.kind === 'booking_picker';
  const { data: bookings, isLoading: bookingsLoading } = useMyBookings();

  function restart() {
    setState(startFlow(helpFlow));
    setText('');
    setThreadId(null);
    setViewOpen(false);
    setPhase('flow');
    submit.reset();
  }

  async function handleSubmit() {
    setPhase('submitting');
    try {
      const detail = await submit.mutateAsync(buildSubmission(helpFlow, state));
      setThreadId(detail.thread.id);
      setPhase('done');
    } catch {
      // mutation error surfaces via submit.isError; allow retry.
      setPhase('flow');
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Transcript */}
      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        <Bubble from="bot">
          Answer a few quick questions and we’ll start a conversation with the right
          team — you can follow their replies right here on Circls.
        </Bubble>

        {state.transcript.map((entry, i) => (
          <div key={i} className="space-y-2">
            <Bubble from="bot">{entry.question}</Bubble>
            <Bubble from="user">{entry.answer}</Bubble>
          </div>
        ))}

        {/* Current bot prompt (until done) */}
        {phase !== 'done' && <Bubble from="bot">{node.prompt}</Bubble>}

        {/* Submission failure reads as part of the conversation (429 / bad booking). */}
        {showError && (
          <div ref={errorRef}>
            <Bubble from="bot">
              <p className="font-semibold text-petal-red">{submitErrorMessage(submit.error)}</p>
            </Bubble>
          </div>
        )}

        {phase === 'done' && threadId && (
          <Bubble from="bot">
            <p className="font-semibold">Your conversation has started. ✅</p>
            <p className="mt-1">
              We’ve shared your details with the right team — replies will land in this
              thread, and you can pick it up any time from{' '}
              <Link
                href="/me/questions"
                className="font-semibold text-coral-deep underline"
                onClick={onClose}
              >
                My questions
              </Link>
              .
            </p>
          </Bubble>
        )}
      </div>

      {/* Controls */}
      <div className="border-t-[2px] border-ink/10 px-4 py-3">
        {phase === 'done' ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => setViewOpen(true)}>
              View your conversation
            </Button>
            <Button variant="secondary" size="sm" onClick={restart}>
              Ask something else
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : node.kind === 'question' ? (
          <div className="flex flex-col gap-2">
            {node.options.map((opt, i) => (
              <Button
                key={opt.label}
                variant="secondary"
                size="sm"
                className="justify-start text-left"
                onClick={() => setState(chooseOption(helpFlow, state, i))}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        ) : node.kind === 'booking_picker' ? (
          <div className="flex flex-col gap-2">
            {bookingsLoading && needsBookings ? (
              <p className="text-sm text-ink-soft">Loading your bookings…</p>
            ) : (
              <>
                {(bookings ?? []).slice(0, 8).map((b) => (
                  <Button
                    key={b.id}
                    variant="secondary"
                    size="sm"
                    className="justify-start text-left"
                    onClick={() =>
                      setState(chooseBooking(helpFlow, state, { id: b.id, label: bookingLabel(b) }))
                    }
                  >
                    {bookingLabel(b)}
                  </Button>
                ))}
                {(bookings ?? []).length === 0 && (
                  <p className="text-sm text-ink-soft">
                    You don’t have any bookings yet.
                  </p>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start text-left"
                  onClick={() => setState(chooseBooking(helpFlow, state, null))}
                >
                  I don’t see my booking / skip
                </Button>
              </>
            )}
          </div>
        ) : node.kind === 'free_text' ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={node.placeholder ?? 'Type here…'}
              rows={3}
              maxLength={2000}
              className="w-full rounded-[var(--radius)] border-[2px] border-ink bg-white px-3 py-2 text-sm focus:outline-none"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setState(submitFreeText(helpFlow, state, text));
                setText('');
              }}
            >
              Continue
            </Button>
          </div>
        ) : (
          // terminal node: review + submit (errors surface as a transcript bubble)
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={phase === 'submitting'}
              onClick={() => void handleSubmit()}
            >
              Start the conversation
            </Button>
            <Button variant="ghost" size="sm" onClick={restart}>
              Start over
            </Button>
          </div>
        )}
      </div>

      {/* Slide-over transcript of the created thread. ThreadView portals to
          document.body after the help panel's own portal, so it stacks above
          the panel (both z-50; later sibling wins). */}
      <ThreadView threadId={viewOpen ? threadId : null} onClose={() => setViewOpen(false)} />
    </div>
  );
}

/**
 * Help chatbot slide-over (#115), controlled by the caller — opened from the
 * "Chat with us" entry in the profile sidebar. Runs the deterministic MCQ
 * flow, whose terminal step starts a private question thread (support →
 * threads refactor). Signed-out users get a prompt to sign in, since starting
 * a thread requires an authed user.
 */
export function HelpPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const [mounted, setMounted] = useState(false);

  // Portal target is only available in the browser.
  useEffect(() => setMounted(true), []);

  if (!open || !mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Help">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l-[2.5px] border-ink bg-surface shadow-offset">
        <div className="flex items-center justify-between border-b-[2.5px] border-ink px-4 py-3">
          <h2 className="font-display text-lg font-extrabold text-ink">Help</h2>
          <button
            onClick={onClose}
            aria-label="Close help"
            className="text-xl font-bold text-ink-soft hover:text-ink"
          >
            ✕
          </button>
        </div>

        {user ? (
          <HelpConversation onClose={onClose} />
        ) : (
          <div className="flex flex-1 flex-col items-start gap-3 px-4 py-6">
            <p className="text-sm text-ink">
              Please sign in so we can connect your enquiry to your account and
              bookings.
            </p>
            <Link href="/login" onClick={onClose}>
              <Button variant="primary" size="sm">Sign in</Button>
            </Link>
            <p className="text-xs text-ink-soft">
              Answer a few guided questions and we’ll start a private conversation
              with the right team — you can follow replies in My questions.
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
