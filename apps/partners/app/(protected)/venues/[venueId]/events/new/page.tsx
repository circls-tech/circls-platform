'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { isSeriesResult, useCreateEvent } from '@/lib/api/events';
import { useMyRole, useVenues, uploadEventImageFile, useTenantProfile } from '@/lib/api/queries';
import { useCurrency } from '@/lib/currency';
import { useOrg } from '@/lib/org_context';
import { TiersEditor, emptyTier, tiersToPayload, type TierDraft } from '@/components/TiersEditor';
import { EventQuestionsEditor } from '@/components/EventQuestionsEditor';
import {
  hasChoiceQuestionWithoutOptions,
  questionsToPayload,
  type QuestionDraft,
} from '@/lib/events/questions';
import { MaxPerUserField, maxPerUserToPayload } from '@/components/MaxPerUserField';
import {
  PostBookingRedirectEditor,
  isValidRedirectUrl,
  redirectToPayload,
} from '@/components/PostBookingRedirectEditor';
import type { PostBookingRedirect } from '@/lib/api/types';
import { PendingPhotosPicker, type PendingPhoto } from '@/components/PendingPhotos';
import { RoleNotice } from '@/components/RoleNotice';
import { RestoredFormNotice } from '@/components/RestoredFormNotice';
import { FormAutosaveScope, useAutosave, useFormAutosave } from '@/lib/use_form_autosave';
import {
  RecurrenceEditor,
  emptyRecurrence,
  occurrencePayloads,
  type RecurrenceValue,
} from '@/components/RecurrenceEditor';
import { BackLink, Button, Card, Input } from '@/lib/ui';
import { brandOf, scratchEvent } from '@/lib/api/scratch_listing';
import { ScratchPreview } from '@/components/ScratchPreview';

/**
 * Convert a `<input type="datetime-local">` value (interpreted as Asia/Kolkata
 * by venue convention) into a UTC ISO string. Browsers treat the value as
 * local-time; we re-interpret it in the venue's tz so the API receives the
 * correct absolute instant regardless of where the partner happens to be.
 */
function localToVenueTzIso(local: string, tz: string): string {
  if (!local) return '';
  // Build a probe Date that represents the local-time string as if it were UTC,
  // then back out the tz offset by formatting in `tz` and computing the diff.
  const asIfUtc = new Date(`${local}:00Z`);
  // The tz "wall clock" string of the asIfUtc instant:
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(asIfUtc);
  // wall: "YYYY-MM-DD, HH:MM:SS"
  const [datePart, timePart] = wall.split(', ');
  const wallIso = `${datePart}T${timePart}Z`;
  const offsetMs = new Date(wallIso).getTime() - asIfUtc.getTime();
  return new Date(asIfUtc.getTime() - offsetMs).toISOString();
}

/** What the form autosaves: every field but the photos, which are files. */
interface VenueEventFields {
  name: string;
  description: string;
  startsAtLocal: string;
  endsAtLocal: string;
  tiers: TierDraft[];
  questions: QuestionDraft[];
  maxPerUser: string | null;
  redirect: PostBookingRedirect | null;
  recurrence: RecurrenceValue;
}

export default function NewEventPage() {
  const { venueId } = useParams<{ venueId: string }>();
  return (
    <FormAutosaveScope>
      <NewVenueEventForm key={venueId} />
    </FormAutosaveScope>
  );
}

function NewVenueEventForm() {
  const router = useRouter();
  const { venueId } = useParams<{ venueId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const createEvent = useCreateEvent(venueId);
  const currency = useCurrency({ venueId });
  // For Advanced-settings venue overrides on recurring events (needs tenantId).
  const { data: venues } = useVenues(tenantId);
  // The ?tenantId link param first; without it, the active organisation.
  const { activeTenantId } = useOrg();
  const { can, isLoading: roleLoading } = useMyRole(tenantId || activeTenantId);

  const autosave = useFormAutosave<VenueEventFields>('venue-event-new', [venueId]);
  const saved = autosave.restored;

  const [name, setName] = useState(saved?.name ?? '');
  const [description, setDescription] = useState(saved?.description ?? '');
  const [startsAtLocal, setStartsAtLocal] = useState(saved?.startsAtLocal ?? '');
  const [endsAtLocal, setEndsAtLocal] = useState(saved?.endsAtLocal ?? '');
  // The customer-site preview of the form as it stands (nothing saved).
  const [previewOpen, setPreviewOpen] = useState(false);
  // The page is meaningless without a name and a start; the rest may be blank.
  const canPreview = name.trim().length > 0 && startsAtLocal.length > 0;
  useEffect(() => {
    if (!canPreview) setPreviewOpen(false);
  }, [canPreview]);
  const [tiers, setTiers] = useState<TierDraft[]>(() => saved?.tiers ?? [emptyTier()]);
  const [questions, setQuestions] = useState<QuestionDraft[]>(saved?.questions ?? []);
  // null = no per-customer ticket limit; else the count input's string value.
  const [maxPerUser, setMaxPerUser] = useState<string | null>(saved?.maxPerUser ?? null);
  const [redirect, setRedirect] = useState<PostBookingRedirect | null>(saved?.redirect ?? null);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(() => saved?.recurrence ?? emptyRecurrence());
  const [err, setErr] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  useAutosave<VenueEventFields>(autosave, {
    name,
    description,
    startsAtLocal,
    endsAtLocal,
    tiers,
    questions,
    maxPerUser,
    redirect,
    recurrence,
  });

  // Best-effort tz; the venue row owns the source of truth but we keep this
  // page tz-pinned to IST for now (matches the rest of the app's IST UI).
  const tz = 'Asia/Kolkata';
  const busy = createEvent.isPending || uploadProgress !== null;
  const thisVenue = venues?.find((v) => v.id === venueId);
  const { data: profile } = useTenantProfile(tenantId || activeTenantId || '');

  const eventsHref = `/venues/${venueId}/events${tenantId ? `?tenantId=${tenantId}` : ''}`;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    // A draft is saved with what is there: dates and tiers may wait (Submit
    // for review asks for them). One date without the other, or a half-filled
    // tier, is a slip rather than a gap.
    if (Boolean(startsAtLocal) !== Boolean(endsAtLocal)) {
      setErr('Set both a start and an end time, or leave both for later.');
      return;
    }
    const namedTiers = tiers.filter((t) => t.name.trim());
    // An untouched tier row (no name, zero price, nothing else) is simply dropped.
    const halfFilled = (t: TierDraft) =>
      t.name.trim() === '' && (parseFloat(t.priceRupees || '0') > 0 || Boolean(t.description?.trim()) || Boolean(t.capacity?.trim()));
    if (tiers.some(halfFilled)) {
      setErr('Give every ticket tier a name, or remove the empty ones.');
      return;
    }
    if (hasChoiceQuestionWithoutOptions(questions)) {
      setErr('Give every choice question at least 2 options.');
      return;
    }
    if (redirect && redirect.url.trim() && !isValidRedirectUrl(redirect.url)) {
      setErr('Enter a full http:// or https:// link for the after-booking step.');
      return;
    }

    const isWeekly = recurrence.mode === 'weekly';
    const occurrences = isWeekly
      ? occurrencePayloads(
          recurrence,
          (ovId) => venues?.find((v) => v.id === ovId)?.tzName ?? tz,
          localToVenueTzIso,
        )
      : undefined;
    if (isWeekly) {
      if (!recurrence.until) {
        setErr('Pick the last date of the recurring event.');
        return;
      }
      if ((occurrences?.length ?? 0) < 2) {
        setErr(
          'A recurring event needs at least 2 dates — adjust the days or last date, or switch to "One time".',
        );
        return;
      }
      if (occurrences!.some((o) => o.tiers?.some((t) => !t.name.trim()))) {
        setErr('Give every custom ticket tier (Advanced settings) a name.');
        return;
      }
    }

    try {
      const result = await createEvent.mutateAsync({
        name,
        ...(description ? { description } : {}),
        ...(occurrences
          ? { occurrences }
          : startsAtLocal && endsAtLocal
            ? {
                startsAt: localToVenueTzIso(startsAtLocal, tz),
                endsAt: localToVenueTzIso(endsAtLocal, tz),
              }
            : {}),
        tiers: tiersToPayload(namedTiers),
        questions: questionsToPayload(questions),
        maxPerUser: maxPerUserToPayload(maxPerUser),
        postBookingRedirect: redirectToPayload(redirect),
      });
      autosave.clear();
      // For a series, photos land on the first date — the other dates (and the
      // consumer pages) borrow that gallery.
      const anchor = isSeriesResult(result) ? result.events[0]! : result;
      if (photos.length > 0) {
        setUploadProgress({ done: 0, total: photos.length });
        try {
          for (let i = 0; i < photos.length; i++) {
            await uploadEventImageFile(anchor.id, photos[i]!.file);
            setUploadProgress({ done: i + 1, total: photos.length });
          }
        } catch (uploadErr) {
          setUploadProgress(null);
          setErr(
            `Your event was created, but a photo failed to upload (${(uploadErr as Error).message}) — you can add the rest from the event page.`,
          );
          router.push(
            `/venues/${venueId}/events/${anchor.id}${tenantId ? `?tenantId=${tenantId}` : ''}`,
          );
          return;
        }
        setUploadProgress(null);
      }
      router.push(eventsHref);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // Only once the role is known, so Owners and Managers never see it flash up.
  if (!roleLoading && !can('events.write')) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink href={eventsHref}>Events</BackLink>
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">New event</h1>
        <RoleNotice>Your role can’t create events — Owners and Managers can.</RoleNotice>
      </div>
    );
  }

  return (
    <div className={previewOpen ? 'flex flex-col gap-6 xl:pr-[var(--scratch-preview-w)]' : 'flex flex-col gap-6'}>
      <BackLink href={eventsHref}>Events</BackLink>
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">New event</h1>

      <Card title="Details" subtitle="Only a name is needed to save a draft — dates and ticket tiers can follow. Submit for review from the event's page when it's complete; Circls approves it before it goes live.">
        <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
          <RestoredFormNotice autosave={autosave} unkept="Photos aren’t kept — add them again." />
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Sunday Tournament"
          />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label={`Starts (${tz})`}
              type="datetime-local"
              value={startsAtLocal}
              onChange={(e) => setStartsAtLocal(e.target.value)}
            />
            <Input
              label={`Ends (${tz})`}
              type="datetime-local"
              value={endsAtLocal}
              onChange={(e) => setEndsAtLocal(e.target.value)}
            />
          </div>

          <RecurrenceEditor
            value={recurrence}
            onChange={setRecurrence}
            baseStartLocal={startsAtLocal}
            baseEndLocal={endsAtLocal}
            venues={(venues ?? []).filter((v) => v.id !== venueId).map((v) => ({ id: v.id, name: v.name }))}
            baseLocationLabel={`Same as event${thisVenue ? ` — ${thisVenue.name}` : ''}`}
            baseTiers={tiers}
            currency={currency}
          />

          <TiersEditor value={tiers} onChange={setTiers} currency={currency} />

          <EventQuestionsEditor value={questions} onChange={setQuestions} />

          <MaxPerUserField value={maxPerUser} onChange={setMaxPerUser} />

          <PostBookingRedirectEditor value={redirect} onChange={setRedirect} />

          <PendingPhotosPicker photos={photos} onChange={setPhotos} />

          {err && <p className="text-sm text-red-600">{err}</p>}
          {uploadProgress && (
            <p className="text-sm text-slate-600">
              Uploading photos {uploadProgress.done}/{uploadProgress.total}…
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Link
              href={`/venues/${venueId}/events${tenantId ? `?tenantId=${tenantId}` : ''}`}
              onClick={autosave.clear}
              className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </Link>
            <Button
              type="button"
              variant="secondary"
              disabled={!canPreview}
              title={canPreview ? undefined : 'Enter a name and a start time to preview'}
              onClick={() => setPreviewOpen((v) => !v)}
            >
              {previewOpen ? 'Hide preview' : 'Preview'}
            </Button>
            <Button type="submit" loading={busy}>
              {recurrence.mode === 'weekly' ? 'Save recurring draft' : 'Save draft'}
            </Button>
          </div>
        </form>
      </Card>
      <ScratchPreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        tenantId={tenantId || activeTenantId || ''}
        type="event"
        listing={scratchEvent({
          tenantId: tenantId || activeTenantId || '',
          brand: brandOf(tenantId || activeTenantId || '', profile),
          name,
          description,
          startsAt: startsAtLocal ? localToVenueTzIso(startsAtLocal, tz) : '',
          endsAt: endsAtLocal ? localToVenueTzIso(endsAtLocal, tz) : '',
          tiers,
          maxPerUser: maxPerUserToPayload(maxPerUser),
          venue: thisVenue,
          tz,
        })}
        files={photos.map((p) => p.file)}
      />
    </div>
  );
}
