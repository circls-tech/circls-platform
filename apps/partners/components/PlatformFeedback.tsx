'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import {
  type PartnerFeedbackPrompt,
  useDismissPartnerFeedback,
  usePartnerFeedbackPrompt,
  useSubmitPartnerFeedback,
} from '@/lib/api/feedback';
import { useOrg } from '@/lib/org_context';
import { Button, Modal } from '@/lib/ui';

/**
 * The platform survey nudge: a small card in the corner asking an Owner or
 * Manager how the portal is working for them, which opens the survey (how easy
 * creating events, venues and membership plans was, challenges, overall ease,
 * anything else). The server decides who is asked and when (see
 * feedback_service); one answer covers the whole organisation. "Not now"
 * brings it back a week later; closing the survey only puts it away for this
 * visit. It is shown at most once per session and organisation, and never on
 * Check-in or a create form (whose live preview sits in the same corner).
 */

const HANDLED_KEY = 'circls.feedbackHandled';

const NOT_TRIED = 'not_tried' as const;
type ScaleValue = number | typeof NOT_TRIED | null;

function toRating(v: ScaleValue): number | null {
  return typeof v === 'number' ? v : null;
}

const LABEL = 'text-[11px] font-medium uppercase tracking-wide text-[#475569]';
const TEXTAREA =
  'w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300';

function Scale({
  label,
  value,
  onChange,
  offerNotTried,
}: {
  label: string;
  value: ScaleValue;
  onChange: (v: ScaleValue) => void;
  offerNotTried?: boolean;
}) {
  const notTried = value === NOT_TRIED;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL}>{label}</span>
        {offerNotTried && (
          <button
            type="button"
            aria-pressed={notTried}
            onClick={() => onChange(notTried ? null : NOT_TRIED)}
            className={[
              'shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
              notTried
                ? 'border-[#17151D] bg-[#CDBBF7] text-[#17151D]'
                : 'border-slate-300 bg-white text-slate-500 hover:border-slate-500',
            ].join(' ')}
          >
            Haven’t tried yet
          </button>
        )}
      </div>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-10 gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
          const selected = value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${n} out of 10`}
              onClick={() => onChange(n)}
              className={[
                'flex h-9 items-center justify-center rounded-[var(--radius)] border-2 text-sm font-semibold tabular-nums transition-colors',
                selected
                  ? 'border-[#17151D] bg-brand-600 text-slate-900'
                  : notTried
                    ? 'border-slate-200 bg-white text-slate-300'
                    : 'border-[#17151D] bg-white text-slate-700 hover:bg-slate-50',
              ].join(' ')}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] text-slate-500">
        <span>Very hard</span>
        <span>Very easy</span>
      </div>
    </div>
  );
}

function Survey({
  prompt,
  tenantId,
  onDone,
  onDismiss,
}: {
  prompt: PartnerFeedbackPrompt;
  tenantId: string;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const submit = useSubmitPartnerFeedback(tenantId);
  const [event, setEvent] = useState<ScaleValue>(prompt.tried.events ? null : NOT_TRIED);
  const [venue, setVenue] = useState<ScaleValue>(prompt.tried.venues ? null : NOT_TRIED);
  const [membership, setMembership] = useState<ScaleValue>(prompt.tried.memberships ? null : NOT_TRIED);
  const [challenges, setChallenges] = useState('');
  const [overall, setOverall] = useState<ScaleValue>(null);
  const [comments, setComments] = useState('');
  const [thanks, setThanks] = useState(false);

  useEffect(() => {
    if (!thanks) return;
    const t = setTimeout(onDone, 1800);
    return () => clearTimeout(t);
  }, [thanks, onDone]);

  async function send() {
    try {
      await submit.mutateAsync({
        overallRating: toRating(overall) ?? 0,
        eventCreationRating: toRating(event),
        venueCreationRating: toRating(venue),
        membershipCreationRating: toRating(membership),
        ...(challenges.trim() ? { challenges: challenges.trim() } : {}),
        ...(comments.trim() ? { comments: comments.trim() } : {}),
      });
      setThanks(true);
    } catch (e) {
      // A teammate answered first — the org is covered, nothing left to ask.
      if (e instanceof ApiError && e.code === 'feedback_exists') onDone();
    }
  }

  if (thanks) {
    return <p className="text-sm text-slate-700">Thanks — every answer is read by the Circls team.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Padded inside so the last field's border and focus ring aren't clipped by the scroll edge. */}
      <div className="-mx-1 -mb-1 flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-1 pb-1">
        <p className="text-sm text-slate-600">
          A few questions about the partner portal. One answer covers your whole organisation; only the overall
          question is required.
        </p>
        <p className="text-sm font-semibold text-slate-800">How easy was it to create…</p>
        <Scale label="An event" value={event} onChange={setEvent} offerNotTried />
        <Scale label="A venue" value={venue} onChange={setVenue} offerNotTried />
        <Scale label="A membership plan" value={membership} onChange={setMembership} offerNotTried />
        <div className="flex flex-col gap-1">
          <label htmlFor="partner-feedback-challenges" className={LABEL}>
            Any challenges you faced? (optional)
          </label>
          <textarea
            id="partner-feedback-challenges"
            value={challenges}
            onChange={(e) => setChallenges(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Something confusing, slow or missing…"
            className={TEXTAREA}
          />
        </div>
        <Scale label="Overall, how easy is the platform to use?" value={overall} onChange={setOverall} />
        <div className="flex flex-col gap-1">
          <label htmlFor="partner-feedback-comments" className={LABEL}>
            Any other comments? (optional)
          </label>
          <textarea
            id="partner-feedback-comments"
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Ideas, wishes, kind words…"
            className={TEXTAREA}
          />
        </div>
      </div>
      {submit.isError && !(submit.error instanceof ApiError && submit.error.code === 'feedback_exists') && (
        <p className="text-sm text-red-600">Couldn’t send your feedback — please try again.</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Not now
        </Button>
        <Button
          size="sm"
          loading={submit.isPending}
          disabled={typeof overall !== 'number'}
          onClick={() => void send()}
        >
          Send feedback
        </Button>
      </div>
    </div>
  );
}

/** Door staff scanning tickets, and the New event / New plan forms with their
 *  live preview in the bottom-right corner. */
function quietPath(pathname: string): boolean {
  return pathname === '/check-in' || pathname.startsWith('/check-in/') || pathname.endsWith('/new');
}

function handledThisSession(tenantId: string): boolean {
  try {
    return sessionStorage.getItem(`${HANDLED_KEY}:${tenantId}`) != null;
  } catch {
    return false;
  }
}

export function PlatformFeedback() {
  const { activeTenantId } = useOrg();
  const pathname = usePathname() ?? '';
  const live = usePartnerFeedbackPrompt(activeTenantId).data ?? null;
  const dismissMutation = useDismissPartnerFeedback(activeTenantId);
  // The prompt on screen, held apart from the query: answering refetches it
  // to null, which mustn't pull the survey away mid-"thanks".
  const [prompt, setPrompt] = useState<PartnerFeedbackPrompt | null>(null);
  const [open, setOpen] = useState(false);

  // Switching organisation drops the other org's survey.
  useEffect(() => {
    setPrompt(null);
    setOpen(false);
  }, [activeTenantId]);

  useEffect(() => {
    if (live && activeTenantId && !prompt && !handledThisSession(activeTenantId)) setPrompt(live);
  }, [live, prompt, activeTenantId]);

  /** Put it away for this visit; nothing is recorded server-side. */
  const close = useCallback(() => {
    try {
      if (activeTenantId) sessionStorage.setItem(`${HANDLED_KEY}:${activeTenantId}`, '1');
    } catch {
      // Storage unavailable — the server-side "Not now" still holds.
    }
    setOpen(false);
    setPrompt(null);
  }, [activeTenantId]);

  function dismiss() {
    dismissMutation.mutate();
    close();
  }

  const quiet = quietPath(pathname);
  if (!prompt || !activeTenantId) return null;

  return (
    <>
      {!open && !quiet && (
        <div
          role="region"
          aria-label="Feedback"
          className="fixed inset-x-4 bottom-4 z-30 rounded-[var(--radius)] border-2 border-[#17151D] bg-white p-4 shadow-[4px_4px_0_#17151D] sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-80"
        >
          <p className="text-sm font-semibold text-[#17151D]">How’s Circls working for you?</p>
          <p className="mt-1 text-sm text-slate-600">
            Tell us how easy it’s been to set things up — it takes about a minute.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Not now
            </Button>
            <Button size="sm" petal="#FCE38A" onClick={() => setOpen(true)}>
              Share feedback
            </Button>
          </div>
        </div>
      )}
      <Modal open={open} onClose={close} title="How’s Circls working for you?">
        <Survey
          prompt={prompt}
          tenantId={activeTenantId}
          onDismiss={dismiss}
          onDone={close}
        />
      </Modal>
    </>
  );
}
