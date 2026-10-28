'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useCreateArena, useCreateTenant, useCreateVenue } from '@/lib/api/queries';
import { inferSport } from '@/lib/api/sport_inference';
import { useOrg } from '@/lib/org_context';
import { Badge, Button, Card, Input, TagsInput } from '@/lib/ui';
import type { Tenant } from '@/lib/api/types';
import { TermsAcceptance } from '@/components/TermsAcceptance';
import { RestoredFormNotice } from '@/components/RestoredFormNotice';
import { CirclsHelp } from '@/components/CirclsHelp';
import { NewEventForm } from '@/components/NewEventForm';
import { NewPlanForm } from '@/components/NewPlanForm';
import { FormAutosaveScope, useAutosave, useFormAutosave } from '@/lib/use_form_autosave';
import { CURRENT_TERMS_VERSION, type TermsCountry } from '@/lib/terms/constants';

// ─── helpers ─────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Steps and paths ─────────────────────────────────────────────────────────

/** What a new organisation sets up first, once it has a name. */
type StartWith = 'event' | 'membership' | 'venue';

type Step = 'org' | 'start' | 'venue' | 'arena' | 'schedule' | 'event' | 'plan' | 'done';

const STEP_LABELS: Record<Step, string> = {
  org: 'Organisation',
  start: 'Start with',
  venue: 'Venue',
  arena: 'Arena',
  schedule: 'Schedule',
  event: 'Event',
  plan: 'Plan',
  done: 'Next steps',
};

/** The steps after the choice, per path. */
const PATH_STEPS: Record<StartWith, Step[]> = {
  event: ['event', 'done'],
  membership: ['plan', 'done'],
  venue: ['venue', 'arena', 'schedule'],
};

/** The stepper's labels: before a path is chosen, one "Set up" stands for its steps. */
function stepLabels(path: StartWith | null): string[] {
  const rest = path ? PATH_STEPS[path].map((s) => STEP_LABELS[s]) : ['Set up'];
  return [STEP_LABELS.org, STEP_LABELS.start, ...rest];
}

function stepIndex(path: StartWith | null, step: Step): number {
  if (step === 'org') return 0;
  if (step === 'start' || !path) return 1;
  return 2 + PATH_STEPS[path].indexOf(step);
}

/** The "Get help from Circls" lead on each step (there's no org to let Circls into before the first). */
const HELP_LEAD: Record<Exclude<Step, 'org'>, string> = {
  start: 'Not sure where to start?',
  venue: 'Need a hand setting up your venue?',
  arena: 'Need a hand setting up your venue?',
  schedule: 'Need a hand setting up your venue?',
  event: 'Need a hand with this event?',
  plan: 'Need a hand with this plan?',
  done: 'Need a hand with the rest?',
};

// ─── Stepper UI ──────────────────────────────────────────────────────────────

function StepperHeader({ labels, current }: { labels: string[]; current: number }) {
  return (
    <div className="flex items-center gap-0">
      {labels.map((label, idx) => {
        const done = idx < current;
        const active = idx === current;
        return (
          <div key={label} className="flex flex-1 items-center">
            {/* Circle */}
            <div className="relative flex flex-col items-center">
              <div
                className={[
                  'flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors',
                  done
                    ? 'border-brand-600 bg-brand-600 text-slate-900'
                    : active
                      ? 'border-[#17151D] bg-white text-[#17151D]'
                      : 'border-slate-300 bg-white text-slate-400',
                ].join(' ')}
              >
                {done ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  idx + 1
                )}
              </div>
              <span
                className={[
                  'mt-1 whitespace-nowrap text-xs font-medium',
                  active ? 'text-brand-600' : done ? 'text-slate-700' : 'text-slate-400',
                ].join(' ')}
              >
                {label}
              </span>
            </div>
            {/* Connector line (not after last) */}
            {idx < labels.length - 1 && (
              <div
                className={[
                  'mx-2 mt-[-18px] h-0.5 flex-1 transition-colors',
                  done ? 'bg-brand-600' : 'bg-slate-200',
                ].join(' ')}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 1: Create Organisation ─────────────────────────────────────────────

/** Autosaved; the terms box isn't — accepting them is ticked afresh. */
interface OrgFields {
  name: string;
  slug: string;
  slugEdited: boolean;
  country: TermsCountry;
}

function blankOrg(): OrgFields {
  return { name: '', slug: '', slugEdited: false, country: 'India' };
}

function Step1Org({ onDone }: { onDone: (tenant: Tenant) => void }) {
  const autosave = useFormAutosave('onboarding-org', [], blankOrg);
  const init = autosave.initial;
  const [name, setName] = useState(init.name);
  const [slug, setSlug] = useState(init.slug);
  const [slugEdited, setSlugEdited] = useState(init.slugEdited);
  const [country, setCountry] = useState<TermsCountry>(init.country);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAutosave<OrgFields>(autosave, { name, slug, slugEdited, country });
  const createTenant = useCreateTenant();
  const { setActiveTenantId } = useOrg();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handleNameChange(v: string) {
    setName(v);
    if (!slugEdited) setSlug(toSlug(v));
  }

  function handleSlugChange(v: string) {
    setSlug(v);
    setSlugEdited(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Organisation name is required.'); return; }
    if (!slug.trim()) { setError('Slug is required.'); return; }
    if (!agreed) { setError('You must accept the Terms & Conditions to continue.'); return; }
    try {
      const tenant = await createTenant.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
        country,
        acceptTerms: true,
        // The text shown is this bundle's copy of the current version.
        documentVersion: CURRENT_TERMS_VERSION,
      });
      autosave.clear();
      setActiveTenantId(tenant.id);
      onDone(tenant);
    } catch (err) {
      const msg = (err as Error).message ?? 'Something went wrong.';
      setError(msg.includes('slug') ? 'That URL slug is already taken — try another.' : msg);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-slate-900">Name your organisation</h3>
        <p className="text-sm text-slate-500">
          This is the business behind your events, memberships and venues. You can update it later
          in Settings.
        </p>
      </div>

      <RestoredFormNotice autosave={autosave} />

      <Input
        ref={nameRef}
        label="Organisation name"
        placeholder="e.g. Greenfield Sports Club"
        value={name}
        onChange={(e) => handleNameChange(e.target.value)}
        error={error && !name.trim() ? error : undefined}
      />

      <Input
        label="URL slug"
        placeholder="greenfield-sports-club"
        value={slug}
        onChange={(e) => handleSlugChange(e.target.value)}
        hint="lowercase letters, numbers and dashes only"
        error={error && name.trim() && !slug.trim() ? error : undefined}
      />

      <TermsAcceptance
        country={country}
        onCountryChange={setCountry}
        agreed={agreed}
        onAgreedChange={setAgreed}
      />

      {error && name.trim() && slug.trim() && (
        <p className="text-sm text-red-600">{error}</p>
      )}

      <div className="flex items-center justify-between pt-2">
        <span />
        <Button
          type="submit"
          variant="primary"
          loading={createTenant.isPending}
          disabled={!name.trim() || !slug.trim() || !agreed}
        >
          Create &amp; continue
        </Button>
      </div>
    </form>
  );
}

// ─── Step 2: Start with ──────────────────────────────────────────────────────

const START_OPTIONS: { path: StartWith; title: string; blurb: string; petal: string }[] = [
  {
    path: 'event',
    title: 'An event',
    blurb: 'A run, a class, a meetup — once or every week — with tickets people book.',
    petal: '#9CE0D4',
  },
  {
    path: 'membership',
    title: 'A membership',
    blurb: 'A pass people buy — monthly unlimited, a 10-class pack, a season pass.',
    petal: '#F9B4D4',
  },
  {
    path: 'venue',
    title: 'A venue',
    blurb: 'A place with courts, pitches or rooms that people book by the slot.',
    petal: '#BCE3A0',
  },
];

/** The sidebar's icon for each (Events, Memberships, Venues). */
function StartWithIcon({ path }: { path: StartWith }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (path) {
    case 'event':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case 'membership':
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'venue':
      return (
        <svg {...common}>
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
  }
}

function Step2StartWith({ onChoose }: { onChoose: (path: StartWith) => void }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-slate-900">What would you like to set up first?</h3>
        <p className="text-sm text-slate-500">
          Pick one to start with — you can add the others any time from the sidebar.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {START_OPTIONS.map((o) => (
          <button
            key={o.path}
            type="button"
            onClick={() => onChoose(o.path)}
            className="flex flex-col items-start gap-2 rounded-[var(--radius)] border-2 border-[#17151D] bg-white p-4 text-left shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5 active:translate-y-0 active:shadow-[1px_1px_0_#17151D]"
          >
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg border-2 border-[#17151D] text-[#17151D]"
              style={{ backgroundColor: o.petal }}
            >
              <StartWithIcon path={o.path} />
            </span>
            <span className="text-sm font-bold text-[#17151D]">{o.title}</span>
            <span className="text-xs text-slate-500">{o.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Venue path: Venue → Arena → Schedule ────────────────────────────────────

function StepVenue({
  tenantId,
  onDone,
  onBack,
}: {
  tenantId: string;
  onDone: (venueId: string) => void;
  onBack: () => void;
}) {
  const autosave = useFormAutosave('onboarding-venue', [tenantId], () => ({
    name: '',
    tags: [] as string[],
  }));
  const [name, setName] = useState(autosave.initial.name);
  const [tags, setTags] = useState<string[]>(autosave.initial.tags);
  const [error, setError] = useState<string | null>(null);
  useAutosave(autosave, { name, tags });
  const createVenue = useCreateVenue(tenantId);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Venue name is required.'); return; }
    try {
      const venue = await createVenue.mutateAsync({ name: name.trim(), tags });
      autosave.clear();
      onDone(venue.id);
    } catch (err) {
      setError((err as Error).message ?? 'Could not create venue.');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-slate-900">Add your first venue</h3>
        <p className="text-sm text-slate-500">
          A venue is a physical location that contains one or more arenas (courts, pitches, etc.).
        </p>
      </div>

      <RestoredFormNotice autosave={autosave} />

      <Input
        ref={nameRef}
        label="Venue name"
        placeholder="e.g. Greenfield Main Campus"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={error ?? undefined}
      />

      <TagsInput
        label="Tags (optional)"
        value={tags}
        onChange={setTags}
        placeholder="e.g. indoor, premium…"
      />

      <div className="flex items-center justify-between pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={createVenue.isPending}
          disabled={!name.trim()}
        >
          Add venue
        </Button>
      </div>
    </form>
  );
}

const SPORT_OPTIONS = [
  'Badminton', 'Basketball', 'Cricket', 'Football', 'Padel',
  'Pickleball', 'Squash', 'Table Tennis', 'Tennis', 'Volleyball', 'Other',
];

function StepArena({
  venueId,
  onDone,
  onSkip,
}: {
  venueId: string | null;
  onDone: (arenaId: string) => void;
  onSkip: () => void;
}) {
  const autosave = useFormAutosave('onboarding-arena', [venueId], () => ({
    name: '',
    sport: '',
    tags: [] as string[],
  }));
  const init = autosave.initial;
  const [name, setName] = useState(init.name);
  const [sport, setSport] = useState(init.sport);
  const [tags, setTags] = useState<string[]>(init.tags);
  const [error, setError] = useState<string | null>(null);
  useAutosave(autosave, { name, sport, tags });
  const createArena = useCreateArena(venueId ?? '');
  const nameRef = useRef<HTMLInputElement>(null);

  const inferredSport = !sport ? inferSport(tags) : null;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  if (!venueId) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-slate-900">Add an arena</h3>
          <p className="text-sm text-slate-500">No venue was created — skipping arena setup.</p>
        </div>
        <div className="flex justify-end pt-2">
          <Button variant="primary" onClick={onSkip}>Continue</Button>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Arena name is required.'); return; }
    try {
      const arena = await createArena.mutateAsync({
        name: name.trim(),
        sport: sport.trim() || undefined,
        tags,
      });
      autosave.clear();
      onDone(arena.id);
    } catch (err) {
      setError((err as Error).message ?? 'Could not create arena.');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-slate-900">Add your first arena</h3>
        <p className="text-sm text-slate-500">
          An arena is a bookable court, pitch, or lane inside your venue.
        </p>
      </div>

      <RestoredFormNotice autosave={autosave} />

      <Input
        ref={nameRef}
        label="Arena name"
        placeholder="e.g. Court 1"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={error ?? undefined}
      />

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Sport (optional)
        </label>
        <select
          value={sport}
          onChange={(e) => setSport(e.target.value)}
          className="w-full rounded-[var(--radius)] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 transition-colors hover:border-slate-300"
        >
          <option value="">Select a sport…</option>
          {SPORT_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <TagsInput
        label="Tags (optional)"
        value={tags}
        onChange={setTags}
        placeholder="e.g. nets, indoor, 5-a-side…"
      />

      {inferredSport && (
        <p className="text-xs text-slate-500">
          Will be classified as: <span className="font-semibold text-slate-700">{inferredSport}</span>
        </p>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button type="button" variant="ghost" onClick={() => { autosave.clear(); onSkip(); }}>
          Skip for now
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={createArena.isPending}
          disabled={!name.trim()}
        >
          Add arena
        </Button>
      </div>
    </form>
  );
}

/** Back to the choice, to add an event, plan or venue as well. */
function SetUpAnother({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-center text-sm text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
    >
      Set up something else too
    </button>
  );
}

function StepSchedule({
  arenaId,
  onFinish,
  onAnother,
}: {
  arenaId: string | null;
  onFinish: () => void;
  onAnother: () => void;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-slate-900">Set a schedule</h3>
        <p className="text-sm text-slate-500">
          Define which hours your arena is open and how long each slot should be. You can always
          come back to this from the arena detail page.
        </p>
      </div>

      <div className="rounded-[var(--radius)] border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm text-slate-700">
          The schedule builder lets you set opening hours, block-out days and slot durations —
          all in a visual week grid.
        </p>
      </div>

      {arenaId ? (
        <div className="flex flex-col gap-3 pt-2">
          <Button
            variant="primary"
            className="w-full"
            onClick={() => router.push(`/arenas/${arenaId}/schedule`)}
          >
            Open schedule builder
          </Button>
          <Button
            variant="secondary"
            className="w-full"
            onClick={onFinish}
          >
            Finish — go to dashboard
          </Button>
          <SetUpAnother onClick={onAnother} />
        </div>
      ) : (
        <div className="flex flex-col gap-3 pt-2">
          <p className="text-xs text-slate-400">
            No arena was set up yet. You can add schedules after creating an arena from the Venues
            page.
          </p>
          <Button variant="primary" className="w-full" onClick={onFinish}>
            Go to dashboard
          </Button>
          <SetUpAnother onClick={onAnother} />
        </div>
      )}
    </div>
  );
}

// ─── Event and membership paths: the last step ───────────────────────────────

function StepDone({
  path,
  saved,
  uploadProblem,
  onOpen,
  onFinish,
  onAnother,
}: {
  path: 'event' | 'membership';
  saved: { id: string; draft: boolean };
  /** A photo or the artwork that didn't upload, said once, right after saving. */
  uploadProblem: string | null;
  onOpen: (href: string) => void;
  onFinish: () => void;
  onAnother: () => void;
}) {
  const isEvent = path === 'event';
  const href = isEvent ? `/events/${saved.id}` : `/memberships/${saved.id}`;
  const title = isEvent
    ? 'Your event is saved as a draft'
    : saved.draft
      ? 'Your plan is saved as a draft'
      : 'Your plan is with Circls for review';
  const body = isEvent
    ? 'Fill in anything you left for later — dates, location, ticket tiers, photos — then press Submit for review on the event’s page. Circls approves every event before customers can see it.'
    : saved.draft
      ? 'Add its tiers and anything else on the plan’s page, then press Submit for review there. Circls approves every plan before customers can see it.'
      : 'Circls approves every plan before customers can see it. Its page shows where it stands.';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <p className="text-sm text-slate-500">{body}</p>
      </div>

      {uploadProblem && <p className="text-sm text-red-600">{uploadProblem}</p>}

      <div className="flex flex-col gap-3 pt-2">
        <Button variant="primary" className="w-full" onClick={() => onOpen(href)}>
          {isEvent ? 'Open your event' : 'Open your plan'}
        </Button>
        <Button variant="secondary" className="w-full" onClick={onFinish}>
          Finish — go to dashboard
        </Button>
        <SetUpAnother onClick={onAnother} />
      </div>
    </div>
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

interface WizardProgress {
  step: Step;
  tenantId: string | null;
  /** Chosen on the second step; null until then (and again on "Set up something else"). */
  path: StartWith | null;
  venueId: string | null;
  arenaId: string | null;
  /** The event or plan the event and membership paths saved, for their last step. */
  saved: { id: string; draft: boolean } | null;
}

export default function OnboardingPage() {
  const router = useRouter();
  const { activeTenantId, setActiveTenantId, tenants } = useOrg();
  // Where they had got to, so going Back to the wizard (from the schedule
  // builder, say) resumes it instead of offering to create the organisation
  // again. Not for an organisation they no longer belong to: that starts over.
  // (The layout only renders this once their organisations have loaded.)
  const progress = useFormAutosave(
    'onboarding',
    [],
    (): WizardProgress => ({
      step: 'org',
      tenantId: activeTenantId,
      path: null,
      venueId: null,
      arenaId: null,
      saved: null,
    }),
    (p) =>
      // A copy from before the paths numbered its steps: start over.
      p.step in STEP_LABELS &&
      (p.tenantId === null || tenants.some((t) => t.id === p.tenantId)) &&
      (p.step === 'org' || p.tenantId !== null) &&
      (p.step === 'org' || p.step === 'start' || p.path !== null) &&
      (p.step !== 'done' || p.saved !== null),
  );
  const resumed = progress.initial;

  const [step, setStep] = useState<Step>(resumed.step);
  const [tenantId, setTenantId] = useState<string | null>(resumed.tenantId);
  const [path, setPath] = useState<StartWith | null>(resumed.path);
  const [venueId, setVenueId] = useState<string | null>(resumed.venueId);
  const [arenaId, setArenaId] = useState<string | null>(resumed.arenaId);
  const [saved, setSaved] = useState<{ id: string; draft: boolean } | null>(resumed.saved);
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);
  useAutosave<WizardProgress>(progress, { step, tenantId, path, venueId, arenaId, saved });

  // The help button, and the currency the event and plan forms price in, go
  // by the active organisation: keep it the one being set up.
  useEffect(() => {
    if (step === 'org' || !tenantId || tenantId === activeTenantId) return;
    if (tenants.some((t) => t.id === tenantId)) setActiveTenantId(tenantId);
  }, [step, tenantId, activeTenantId, tenants, setActiveTenantId]);

  // If the user already has an active tenant and somehow lands here, still let
  // them proceed (they can add more venues/arenas). Only step 1 guards exit.
  const canLeaveSafely = step !== 'org' || tenantId !== null;
  const labels = stepLabels(path);
  const current = stepIndex(path, step);

  function handleOrgDone(tenant: Tenant) {
    setTenantId(tenant.id);
    setStep('start');
  }

  function handleChoose(next: StartWith) {
    setPath(next);
    setSaved(null);
    setStep(PATH_STEPS[next][0]!);
  }

  function handleBackToStart() {
    setPath(null);
    setStep('start');
  }

  function handleVenueDone(vid: string) {
    setVenueId(vid);
    setArenaId(null);
    setStep('arena');
  }

  function handleArenaDone(aid: string) {
    setArenaId(aid);
    setStep('schedule');
  }

  function handleSaved(id: string, draft: boolean, problem: string | null) {
    setSaved({ id, draft });
    setUploadProblem(problem);
    setStep('done');
  }

  function handleLeave(href: string) {
    progress.clear();
    router.push(href);
  }

  function handleFinish() {
    handleLeave('/dashboard');
  }

  return (
    // The event and plan forms' docked preview sets the room it needs while it
    // is open; the wizard moves over for it.
    <div className="px-4 xl:pr-[calc(var(--scratch-preview-w,0px)_+_1rem)]">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 py-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Welcome to circls</h1>
            <p className="mt-1 text-sm text-slate-500">
              Let&apos;s get your account set up in a few quick steps.
            </p>
          </div>
          <Badge tone="neutral" className="shrink-0 whitespace-nowrap" label={`Step ${current + 1} of ${labels.length}`} />
        </div>

        {/* Stepper */}
        <StepperHeader labels={labels} current={current} />

        {step !== 'org' && <CirclsHelp lead={HELP_LEAD[step]} />}

        {/* Step: the event and plan forms bring their own cards. */}
        {step === 'event' && tenantId ? (
          <FormAutosaveScope>
            <NewEventForm
              tenantId={tenantId}
              source={null}
              // A new organisation has no venue unless it made one here first.
              startAt={venueId ? { scope: 'venue', venueId } : { scope: 'standalone' }}
              onCreated={(id, photoError) => handleSaved(id, true, photoError)}
              onBack={handleBackToStart}
            />
          </FormAutosaveScope>
        ) : step === 'plan' && tenantId ? (
          <FormAutosaveScope>
            <NewPlanForm
              tenantId={tenantId}
              onCreated={(id, { draft, artworkError }) => handleSaved(id, draft, artworkError)}
              onBack={handleBackToStart}
            />
          </FormAutosaveScope>
        ) : (
          <Card>
            {step === 'org' && (
              <FormAutosaveScope>
                <Step1Org onDone={handleOrgDone} />
              </FormAutosaveScope>
            )}
            {step === 'start' && <Step2StartWith onChoose={handleChoose} />}
            {step === 'venue' && tenantId && (
              <FormAutosaveScope>
                <StepVenue tenantId={tenantId} onDone={handleVenueDone} onBack={handleBackToStart} />
              </FormAutosaveScope>
            )}
            {step === 'arena' && (
              <FormAutosaveScope>
                <StepArena
                  venueId={venueId}
                  onDone={handleArenaDone}
                  onSkip={() => setStep('schedule')}
                />
              </FormAutosaveScope>
            )}
            {step === 'schedule' && (
              <StepSchedule arenaId={arenaId} onFinish={handleFinish} onAnother={handleBackToStart} />
            )}
            {step === 'done' && saved && (path === 'event' || path === 'membership') && (
              <StepDone
                path={path}
                saved={saved}
                uploadProblem={uploadProblem}
                onOpen={handleLeave}
                onFinish={handleFinish}
                onAnother={handleBackToStart}
              />
            )}
          </Card>
        )}

        {/* Persistent escape hatch (disabled until org is created) */}
        <div className="text-center">
          {canLeaveSafely ? (
            <button
              type="button"
              onClick={handleFinish}
              className="text-sm text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
            >
              Do this later — go to dashboard
            </button>
          ) : (
            <span className="text-xs text-slate-300">
              Create your organisation first to access the dashboard.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
