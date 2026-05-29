'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useCreateArena, useCreateTenant, useCreateVenue } from '@/lib/api/queries';
import { inferSport } from '@/lib/api/sport_inference';
import { useOrg } from '@/lib/org_context';
import { Badge, Button, Card, Input, TagsInput } from '@/lib/ui';
import type { Tenant } from '@/lib/api/types';

// ─── helpers ─────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Stepper UI ──────────────────────────────────────────────────────────────

const STEPS = [
  { label: 'Organisation' },
  { label: 'Venue' },
  { label: 'Arena' },
  { label: 'Schedule' },
];

function StepperHeader({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((step, idx) => {
        const done = idx < current;
        const active = idx === current;
        return (
          <div key={step.label} className="flex flex-1 items-center">
            {/* Circle */}
            <div className="relative flex flex-col items-center">
              <div
                className={[
                  'flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors',
                  done
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : active
                      ? 'border-brand-600 bg-white text-brand-600'
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
                {step.label}
              </span>
            </div>
            {/* Connector line (not after last) */}
            {idx < STEPS.length - 1 && (
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

function Step1Org({ onDone }: { onDone: (tenant: Tenant) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    try {
      const tenant = await createTenant.mutateAsync({ name: name.trim(), slug: slug.trim() });
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
          This is the business that owns your venues. You can update it later in Settings.
        </p>
      </div>

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
        error={error && name.trim() ? error : undefined}
      />

      <div className="flex items-center justify-between pt-2">
        <span />
        <Button
          type="submit"
          variant="primary"
          loading={createTenant.isPending}
          disabled={!name.trim() || !slug.trim()}
        >
          Create &amp; continue
        </Button>
      </div>
    </form>
  );
}

// ─── Step 2: Add Venue ────────────────────────────────────────────────────────

function Step2Venue({
  tenantId,
  onDone,
  onSkip,
}: {
  tenantId: string;
  onDone: (venueId: string) => void;
  onSkip: () => void;
}) {
  const [name, setName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
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
        <Button type="button" variant="ghost" onClick={onSkip}>
          Skip for now
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

// ─── Step 3: Add Arena ────────────────────────────────────────────────────────

const SPORT_OPTIONS = [
  'Badminton', 'Basketball', 'Cricket', 'Football', 'Padel',
  'Pickleball', 'Squash', 'Table Tennis', 'Tennis', 'Volleyball', 'Other',
];

function Step3Arena({
  venueId,
  onDone,
  onSkip,
}: {
  venueId: string | null;
  onDone: (arenaId: string) => void;
  onSkip: () => void;
}) {
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
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
        <Button type="button" variant="ghost" onClick={onSkip}>
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

// ─── Step 4: Schedule ─────────────────────────────────────────────────────────

function Step4Schedule({
  arenaId,
  onFinish,
}: {
  arenaId: string | null;
  onFinish: () => void;
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
        </div>
      )}
    </div>
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();
  const { activeTenantId } = useOrg();

  const [step, setStep] = useState(0);
  const [tenantId, setTenantId] = useState<string | null>(activeTenantId);
  const [venueId, setVenueId] = useState<string | null>(null);
  const [arenaId, setArenaId] = useState<string | null>(null);

  // If the user already has an active tenant and somehow lands here, still let
  // them proceed (they can add more venues/arenas). Only step 1 guards exit.
  const canLeaveSafely = step > 0 || tenantId !== null;

  function handleOrgDone(tenant: Tenant) {
    setTenantId(tenant.id);
    setStep(1);
  }

  function handleVenueDone(vid: string) {
    setVenueId(vid);
    setStep(2);
  }

  function handleArenaDone(aid: string) {
    setArenaId(aid);
    setStep(3);
  }

  function handleFinish() {
    router.push('/dashboard');
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 py-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Welcome to circls</h1>
          <p className="mt-1 text-sm text-slate-500">
            Let&apos;s get your account set up in a few quick steps.
          </p>
        </div>
        <Badge tone="neutral" label={`Step ${step + 1} of ${STEPS.length}`} />
      </div>

      {/* Stepper */}
      <StepperHeader current={step} />

      {/* Step card */}
      <Card>
        {step === 0 && <Step1Org onDone={handleOrgDone} />}
        {step === 1 && tenantId && (
          <Step2Venue
            tenantId={tenantId}
            onDone={handleVenueDone}
            onSkip={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <Step3Arena
            venueId={venueId}
            onDone={handleArenaDone}
            onSkip={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <Step4Schedule arenaId={arenaId} onFinish={handleFinish} />
        )}
      </Card>

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
  );
}
