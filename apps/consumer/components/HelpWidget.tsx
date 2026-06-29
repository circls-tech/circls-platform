'use client';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMyBookings, useSubmitConcern } from '@/lib/api/consumer';
import type { MyBooking } from '@/lib/api/types';
import { Button } from '@/lib/ui';
import { helpFlow } from '@/lib/help/flows';
import {
  buildSubmission,
  chooseBooking,
  chooseOption,
  currentNode,
  isTerminal,
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
  return `${b.venueName} · ${b.itemType} · ${when}`;
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

function HelpConversation({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<FlowState>(() => startFlow(helpFlow));
  const [phase, setPhase] = useState<Phase>('flow');
  const [reference, setReference] = useState<string | null>(null);
  const [text, setText] = useState('');

  const submit = useSubmitConcern();
  const node = currentNode(helpFlow, state);
  const atTerminal = isTerminal(helpFlow, state);

  // Bookings are only needed once we reach a picker; fetch lazily but harmlessly.
  const needsBookings = node.kind === 'booking_picker';
  const { data: bookings, isLoading: bookingsLoading } = useMyBookings();

  function restart() {
    setState(startFlow(helpFlow));
    setText('');
    setReference(null);
    setPhase('flow');
    submit.reset();
  }

  async function handleSubmit() {
    setPhase('submitting');
    try {
      const created = await submit.mutateAsync(buildSubmission(helpFlow, state));
      setReference(created.id);
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
          We’re not offering live chat just yet — but tell us what’s up and we’ll log
          your enquiry and follow up. (Live assistance is coming soon.)
        </Bubble>

        {state.transcript.map((entry, i) => (
          <div key={i} className="space-y-2">
            <Bubble from="bot">{entry.question}</Bubble>
            <Bubble from="user">{entry.answer}</Bubble>
          </div>
        ))}

        {/* Current bot prompt (until done) */}
        {phase !== 'done' && <Bubble from="bot">{node.prompt}</Bubble>}

        {phase === 'done' && reference && (
          <Bubble from="bot">
            <p className="font-semibold">We’ve logged your enquiry. ✅</p>
            <p className="mt-1">
              Reference{' '}
              <span className="font-mono">#{reference.slice(0, 8)}</span>. Our team will
              follow up. Live chat is coming soon — for now this is the fastest way to
              reach us.
            </p>
          </Bubble>
        )}
      </div>

      {/* Controls */}
      <div className="border-t-[2px] border-ink/10 px-4 py-3">
        {phase === 'done' ? (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={restart}>
              Ask something else
            </Button>
            <Button variant="primary" size="sm" onClick={onClose}>
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
          // terminal node: review + submit
          <div className="flex flex-col gap-2">
            {submit.isError && (
              <p className="text-sm text-petal-red">
                Couldn’t send that — please try again.
              </p>
            )}
            <Button
              variant="primary"
              size="sm"
              loading={phase === 'submitting'}
              onClick={() => void handleSubmit()}
            >
              Send to support
            </Button>
            <Button variant="ghost" size="sm" onClick={restart}>
              Start over
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Help entry point + slide-over (#115). Renders a "Help" trigger; clicking it
 * opens a right-side panel running the deterministic MCQ flow. Signed-out users
 * get a prompt to sign in, since logging a concern requires an authed user (#114).
 */
export function HelpWidget() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Portal target is only available in the browser.
  useEffect(() => setMounted(true), []);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        Support
      </Button>

      {open && mounted && createPortal(
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Help">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l-[2.5px] border-ink bg-surface shadow-offset">
            <div className="flex items-center justify-between border-b-[2.5px] border-ink px-4 py-3">
              <h2 className="font-display text-lg font-extrabold text-ink">Help</h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close help"
                className="text-xl font-bold text-ink-soft hover:text-ink"
              >
                ✕
              </button>
            </div>

            {user ? (
              <HelpConversation onClose={() => setOpen(false)} />
            ) : (
              <div className="flex flex-1 flex-col items-start gap-3 px-4 py-6">
                <p className="text-sm text-ink">
                  Please sign in so we can connect your enquiry to your account and
                  bookings.
                </p>
                <Link href="/login" onClick={() => setOpen(false)}>
                  <Button variant="primary" size="sm">Sign in</Button>
                </Link>
                <p className="text-xs text-ink-soft">
                  Live chat isn’t available yet — we’re building it. For now we log your
                  enquiry and follow up.
                </p>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
