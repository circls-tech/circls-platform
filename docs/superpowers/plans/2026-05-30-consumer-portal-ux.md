# Consumer Portal "Premium Club" UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the circls.app consumer portal into the "Premium Club" look (navy + gold, Fraunces/Inter), add a landing page, venues & events listing pages, sport-photo cards with a motif fallback, and the company's legal pages + footer.

**Architecture:** Frontend-only changes in `apps/consumer` (Next.js 15 app-router, React 19, Tailwind v4, TanStack Query v5). A pure `resolveImage` module maps venue tags → self-hosted sport photos with a court-line motif fallback, unit-tested with vitest. All other work is component/page composition verified by `typecheck` + `build` + a manual visual pass. The four backend changes in the spec's §12 are handed off to a separate API agent; this plan consumes the agreed response shapes and degrades gracefully (empty rows) until those endpoints exist.

**Tech Stack:** Next.js 15, React 19, TanStack Query v5, Tailwind CSS v4 (`@theme`), `next/font/google` (Fraunces + Inter), vitest (added here).

**Spec:** `docs/superpowers/specs/2026-05-30-consumer-portal-ux-design.md`

**Conventions for every task:**
- Run commands from `apps/consumer/` unless stated otherwise.
- `pnpm typecheck` = `tsc --noEmit`. `pnpm build` = `next build`. `pnpm test` = `vitest run` (added in Phase 0).
- Commit after each task with the message shown. Work is on the current worktree branch.

---

## File Structure

**Created:**
- `apps/consumer/vitest.config.ts` — vitest config
- `apps/consumer/lib/sportImages.ts` — tag→sport-image resolver (pure, tested)
- `apps/consumer/lib/sportImages.test.ts` — resolver unit tests
- `apps/consumer/public/sports/*.jpg` (12) + `apps/consumer/public/sports/SOURCES.md`
- `apps/consumer/components/SportImage.tsx` — photo+scrim or motif
- `apps/consumer/components/cards/VenueCard.tsx`
- `apps/consumer/components/cards/EventCard.tsx`
- `apps/consumer/components/cards/MembershipCard.tsx`
- `apps/consumer/components/HScroll.tsx` — horizontal scroll-snap row
- `apps/consumer/components/Skeleton.tsx` — shimmer placeholders
- `apps/consumer/components/EmptyState.tsx` — motif + copy
- `apps/consumer/components/Footer.tsx`
- `apps/consumer/components/legal/LegalLayout.tsx` + `apps/consumer/lib/legal/{privacy,terms,refund}.ts`
- `apps/consumer/app/venues/page.tsx` — venues listing (moved from `app/page.tsx`)
- `apps/consumer/app/events/page.tsx` — events listing
- `apps/consumer/app/privacy/page.tsx`, `app/terms/page.tsx`, `app/refund/page.tsx`

**Modified:**
- `apps/consumer/package.json` — vitest devDep + test script
- `apps/consumer/app/globals.css` — Premium Club tokens
- `apps/consumer/app/layout.tsx` — fonts + footer
- `apps/consumer/app/page.tsx` — becomes the landing page
- `apps/consumer/components/Header.tsx` — navy/gold + Venues/Events nav
- `apps/consumer/lib/ui/{Button,Badge,Card,Input}.tsx` — reskin
- `apps/consumer/lib/api/types.ts` — `imageUrl?`, `PublicEventWithVenue`, `PublicMembershipWithScope`
- `apps/consumer/lib/api/consumer.ts` — `useUpcomingEvents`, `useAllMemberships`
- `apps/consumer/lib/format.ts` — `formatDayMonth` helper
- `apps/consumer/app/venues/[venueId]/page.tsx`, `app/me/bookings/page.tsx`, `app/login/page.tsx` — restyle

---

# PHASE 0 — Tooling

## Task 0.1: Add vitest to the consumer app

**Files:**
- Modify: `apps/consumer/package.json`
- Create: `apps/consumer/vitest.config.ts`

- [ ] **Step 1: Install vitest**

Run (from `apps/consumer/`): `pnpm add -D vitest@^2.1.0`

- [ ] **Step 2: Add the test script**

In `apps/consumer/package.json`, add to `"scripts"`:

```json
    "test": "vitest run"
```

- [ ] **Step 3: Create the vitest config**

Create `apps/consumer/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Verify the runner starts (no tests yet)**

Run: `pnpm test`
Expected: vitest runs and reports "No test files found" (exit non-zero is fine here) — confirms vitest is installed.

- [ ] **Step 5: Commit**

```bash
# from repo root
git add apps/consumer/package.json apps/consumer/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(consumer): add vitest runner"
```

---

# PHASE 1 — Design Tokens & Fonts

## Task 1.1: Premium Club tokens in globals.css

**Files:**
- Modify: `apps/consumer/app/globals.css`

- [ ] **Step 1: Replace the `@theme` block and body font**

Replace the entire contents of `apps/consumer/app/globals.css` with:

```css
@import "tailwindcss";

@theme {
  /* Brand — navy ink */
  --color-ink:       #0f1c2e;
  --color-ink-deep:  #0b1424;
  --color-ink-soft:  #1e3a5f;

  /* Accent — gold */
  --color-gold-500:  #e7c87d;
  --color-gold-600:  #c79a3a;
  --color-gold-100:  #f3ead3;
  --color-gold-text: #7a5b1e;

  /* Neutrals — warm */
  --color-surface:      #fbf9f4;
  --color-surface-card: #ffffff;
  --color-border:       #ece3d0;
  --color-text-primary:   #0f1c2e;
  --color-text-secondary: #64748b;
  --color-text-muted:     #94a3b8;

  /* Status tones (retained for booking states) */
  --color-tone-success-bg: #dcfce7; --color-tone-success-text: #166534;
  --color-tone-warning-bg: #fef9c3; --color-tone-warning-text: #854d0e;
  --color-tone-danger-bg:  #fee2e2; --color-tone-danger-text:  #991b1b;
  --color-tone-neutral-bg: #f1f5f9; --color-tone-neutral-text: #64748b;
  --color-tone-booked-bg:  #dbeafe; --color-tone-booked-text:  #1e40af;

  /* Fonts (variables injected by next/font in layout.tsx) */
  --font-sans:    var(--font-inter), ui-sans-serif, system-ui, sans-serif;
  --font-display: var(--font-fraunces), ui-serif, Georgia, serif;

  /* Shape */
  --radius:      0.5rem;
  --radius-card: 1rem;
}

html, body { height: 100%; }

body {
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

*:focus-visible {
  outline: 2px solid var(--color-gold-600);
  outline-offset: 2px;
  border-radius: var(--radius);
}

/* Shimmer for skeleton loaders */
@keyframes shimmer { 100% { transform: translateX(100%); } }
.shimmer { position: relative; overflow: hidden; }
.shimmer::after {
  content: ''; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent);
  animation: shimmer 1.5s infinite;
}

@media (prefers-reduced-motion: reduce) {
  .shimmer::after { animation: none; }
  * { transition: none !important; }
}
```

- [ ] **Step 2: Commit** (build is verified after fonts are wired in Task 1.2)

```bash
git add apps/consumer/app/globals.css
git commit -m "feat(consumer): Premium Club design tokens"
```

## Task 1.2: Wire Fraunces + Inter via next/font

**Files:**
- Modify: `apps/consumer/app/layout.tsx`

- [ ] **Step 1: Load fonts and apply their CSS variables to `<html>`**

Replace `apps/consumer/app/layout.tsx` with:

```tsx
import type { Metadata } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { Footer } from '@/components/Footer';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });

export const metadata: Metadata = {
  title: 'Circls — Find your circle. Book your spot.',
  description: 'Discover and book venues, events and memberships near you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
      <body className="flex min-h-full flex-col">
        <Providers>
          <div className="flex-1">{children}</div>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
```

> Note: `Footer` is created in Task 5.1. If executing strictly in order, temporarily comment the `Footer` import + usage and restore them in Task 5.1. (Subagent-driven execution: do Task 5.1 before the first `pnpm build`.)

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (once `Footer` exists or is temporarily stubbed).

- [ ] **Step 3: Commit**

```bash
git add apps/consumer/app/layout.tsx
git commit -m "feat(consumer): load Fraunces + Inter fonts"
```

## Task 1.3: Reskin UI primitives (Button, Badge, Card, Input)

**Files:**
- Modify: `apps/consumer/lib/ui/Button.tsx`, `Badge.tsx`, `Card.tsx`, `Input.tsx`

- [ ] **Step 1: Button — navy primary + gold `accent`**

In `apps/consumer/lib/ui/Button.tsx`, replace `ButtonVariant` and `variantClasses`:

```ts
export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
```

```ts
const variantClasses: Record<ButtonVariant, string> = {
  primary:   'bg-ink text-white hover:bg-ink-soft border-transparent',
  accent:    'bg-gold-500 text-ink hover:bg-gold-600 border-transparent font-semibold',
  secondary: 'bg-white text-ink border-border hover:bg-gold-100',
  ghost:     'bg-transparent text-text-secondary border-transparent hover:bg-gold-100',
  danger:    'bg-red-600 text-white hover:bg-red-700 border-transparent',
};
```

- [ ] **Step 2: Badge — add `sport` tone**

In `apps/consumer/lib/ui/Badge.tsx`, add `'sport'` to the `BadgeTone` union and to `toneClasses`:

```ts
  sport:   'bg-gold-100 text-gold-text',
```

- [ ] **Step 3: Card — rounder, warm border, optional hover**

In `apps/consumer/lib/ui/Card.tsx`, change the outer wrapper classes and header border:

```tsx
      className={[
        'rounded-card border border-border bg-white shadow-sm',
        className,
      ].join(' ')}
```
and the header divider `border-b border-[#e5e7eb]` → `border-b border-border`.

- [ ] **Step 4: Input — warm border + gold hover**

In `apps/consumer/lib/ui/Input.tsx`, change the non-error branch
`'border-[#e5e7eb] bg-white hover:border-slate-300'` → `'border-border bg-white hover:border-gold-500'`,
and the label color `text-[#475569]` → `text-text-secondary`.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/consumer/lib/ui/
git commit -m "feat(consumer): reskin UI primitives to Premium Club"
```

---

# PHASE 2 — Sport Image System

## Task 2.1: `resolveImage` module (TDD)

**Files:**
- Create: `apps/consumer/lib/sportImages.ts`
- Test: `apps/consumer/lib/sportImages.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/consumer/lib/sportImages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveImage, matchSport } from './sportImages';

describe('matchSport', () => {
  it('matches a canonical tag case-insensitively', () => {
    expect(matchSport(['Badminton'])).toBe('badminton');
  });
  it('folds aliases (soccer → football)', () => {
    expect(matchSport(['Soccer'])).toBe('football');
  });
  it('normalizes whitespace and punctuation', () => {
    expect(matchSport(['Table Tennis'])).toBe('tableTennis');
    expect(matchSport(['5-a-side'])).toBe('football');
  });
  it('returns null when nothing matches', () => {
    expect(matchSport(['Yoga'])).toBeNull();
    expect(matchSport([])).toBeNull();
    expect(matchSport(undefined)).toBeNull();
  });
});

describe('resolveImage', () => {
  it('returns a self-hosted photo for a matched tag', () => {
    const r = resolveImage({ tags: ['tennis'] });
    expect(r).toEqual({ kind: 'photo', src: '/sports/tennis.jpg', sport: 'tennis' });
  });
  it('prefers an uploaded imageUrl over the tag image', () => {
    const r = resolveImage({ imageUrl: 'https://cdn/x.jpg', tags: ['tennis'] });
    expect(r).toEqual({ kind: 'photo', src: 'https://cdn/x.jpg', sport: 'tennis' });
  });
  it('falls back to the motif when no tag matches and no upload', () => {
    expect(resolveImage({ tags: ['yoga'] })).toEqual({ kind: 'motif' });
    expect(resolveImage({})).toEqual({ kind: 'motif' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./sportImages`.

- [ ] **Step 3: Implement the module**

Create `apps/consumer/lib/sportImages.ts`:

```ts
export type CanonicalSport =
  | 'badminton' | 'tennis' | 'football' | 'cricket' | 'basketball'
  | 'swimming' | 'tableTennis' | 'squash' | 'gym' | 'pickleball'
  | 'bouldering' | 'running';

/** Canonical sport → self-hosted asset under public/sports/. */
export const SPORT_IMAGES: Record<CanonicalSport, string> = {
  badminton:   '/sports/badminton.jpg',
  tennis:      '/sports/tennis.jpg',
  football:    '/sports/football.jpg',
  cricket:     '/sports/cricket.jpg',
  basketball:  '/sports/basketball.jpg',
  swimming:    '/sports/swimming.jpg',
  tableTennis: '/sports/table-tennis.jpg',
  squash:      '/sports/squash.jpg',
  gym:         '/sports/gym.jpg',
  pickleball:  '/sports/pickleball.jpg',
  bouldering:  '/sports/bouldering.jpg',
  running:     '/sports/running.jpg',
};

/** Normalized tag (see `normalize`) → canonical sport. Includes self-maps. */
const SPORT_ALIASES: Record<string, CanonicalSport> = {
  badminton: 'badminton', shuttle: 'badminton', shuttlecock: 'badminton',
  tennis: 'tennis', lawntennis: 'tennis',
  football: 'football', soccer: 'football', futsal: 'football', '5aside': 'football', fiveaside: 'football', turf: 'football',
  cricket: 'cricket', nets: 'cricket',
  basketball: 'basketball', hoops: 'basketball', bball: 'basketball',
  swimming: 'swimming', swim: 'swimming', pool: 'swimming', aquatics: 'swimming',
  tabletennis: 'tableTennis', tt: 'tableTennis', pingpong: 'tableTennis',
  squash: 'squash',
  gym: 'gym', fitness: 'gym', workout: 'gym', strength: 'gym',
  pickleball: 'pickleball', pickle: 'pickleball',
  bouldering: 'bouldering', climbing: 'bouldering', climb: 'bouldering',
  running: 'running', run: 'running', marathon: 'running', jogging: 'running', track: 'running',
};

function normalize(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** First tag (in order) that resolves to a canonical sport, else null. */
export function matchSport(tags: string[] | undefined): CanonicalSport | null {
  for (const tag of tags ?? []) {
    const key = SPORT_ALIASES[normalize(tag)];
    if (key) return key;
  }
  return null;
}

export type ResolvedImage =
  | { kind: 'photo'; src: string; sport?: CanonicalSport }
  | { kind: 'motif' };

export interface ResolveImageInput {
  /** Future uploaded photo (backend, deferred). Highest priority when present. */
  imageUrl?: string | null;
  tags?: string[];
}

/** Resolution order: uploaded photo → tag-matched sport photo → motif. */
export function resolveImage(input: ResolveImageInput): ResolvedImage {
  const sport = matchSport(input.tags);
  if (input.imageUrl) {
    return sport ? { kind: 'photo', src: input.imageUrl, sport } : { kind: 'photo', src: input.imageUrl };
  }
  if (sport) return { kind: 'photo', src: SPORT_IMAGES[sport], sport };
  return { kind: 'motif' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test`
Expected: PASS (all 8 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/consumer/lib/sportImages.ts apps/consumer/lib/sportImages.test.ts
git commit -m "feat(consumer): tag→sport-image resolver with motif fallback"
```

## Task 2.2: Download the 12 sport assets

**Files:**
- Create: `apps/consumer/public/sports/*.jpg`, `apps/consumer/public/sports/SOURCES.md`

- [ ] **Step 1: Download the verified Unsplash images**

Run from repo root (creates the dir and fetches all 12):

```bash
mkdir -p apps/consumer/public/sports
cd apps/consumer/public/sports
base="auto=format&fit=crop&w=800&q=80"
curl -sL "https://images.unsplash.com/photo-1708312604109-16c0be9326cd?$base" -o badminton.jpg
curl -sL "https://images.unsplash.com/photo-1547934045-2942d193cb49?$base" -o tennis.jpg
curl -sL "https://images.unsplash.com/photo-1556056504-5c7696c4c28d?$base" -o football.jpg
curl -sL "https://images.unsplash.com/photo-1741776522016-e79a6d0e66fb?$base" -o cricket.jpg
curl -sL "https://images.unsplash.com/photo-1533923156502-be31530547c4?$base" -o basketball.jpg
curl -sL "https://images.unsplash.com/photo-1568903910614-f9c38d346242?$base" -o swimming.jpg
curl -sL "https://images.unsplash.com/photo-1708268411988-d30e0e1eef0c?$base" -o table-tennis.jpg
curl -sL "https://images.unsplash.com/photo-1740813416116-a07511d2e188?$base" -o squash.jpg
curl -sL "https://images.unsplash.com/photo-1545612036-2872840642dc?$base" -o gym.jpg
curl -sL "https://images.unsplash.com/photo-1686721135030-e2ab79e27b16?$base" -o pickleball.jpg
curl -sL "https://images.unsplash.com/photo-1564769662533-4f00a87b4056?$base" -o bouldering.jpg
curl -sL "https://images.unsplash.com/photo-1452626038306-9aae5e071dd3?$base" -o running.jpg
cd -
```

- [ ] **Step 2: Verify all 12 downloaded as JPEGs**

Run: `file apps/consumer/public/sports/*.jpg`
Expected: every line reports "JPEG image data". (Re-run any missing curl if a file is 0 bytes / HTML.)

- [ ] **Step 3: Record provenance**

Create `apps/consumer/public/sports/SOURCES.md`:

```markdown
# Sport card images

All images are from Unsplash (free Unsplash License — no attribution required,
no auth). Downloaded at 800px. Filename = canonical sport key in lib/sportImages.ts.

| File | Unsplash photo ID |
|---|---|
| badminton.jpg | photo-1708312604109-16c0be9326cd |
| tennis.jpg | photo-1547934045-2942d193cb49 |
| football.jpg | photo-1556056504-5c7696c4c28d |
| cricket.jpg | photo-1741776522016-e79a6d0e66fb |
| basketball.jpg | photo-1533923156502-be31530547c4 |
| swimming.jpg | photo-1568903910614-f9c38d346242 |
| table-tennis.jpg | photo-1708268411988-d30e0e1eef0c |
| squash.jpg | photo-1740813416116-a07511d2e188 |
| gym.jpg | photo-1545612036-2872840642dc |
| pickleball.jpg | photo-1686721135030-e2ab79e27b16 |
| bouldering.jpg | photo-1564769662533-4f00a87b4056 |
| running.jpg | photo-1452626038306-9aae5e071dd3 |
```

- [ ] **Step 4: Commit**

```bash
git add apps/consumer/public/sports/
git commit -m "feat(consumer): add curated sport card images"
```

## Task 2.3: `SportImage` component (photo+scrim or motif)

**Files:**
- Create: `apps/consumer/components/SportImage.tsx`

- [ ] **Step 1: Implement the component**

Create `apps/consumer/components/SportImage.tsx`:

```tsx
import { resolveImage, type ResolveImageInput } from '@/lib/sportImages';

const MOTIF_GRID: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(var(--color-gold-500) 2px, transparent 2px), linear-gradient(90deg, var(--color-gold-500) 2px, transparent 2px)',
  backgroundSize: '30px 30px',
};

/** Venue/event/membership image header. Renders the resolved photo with a navy
 *  scrim + sport label, or the court-line motif when no photo is available. */
export function SportImage({
  input,
  alt,
  label,
  className = '',
}: {
  input: ResolveImageInput;
  alt: string;
  label?: string;
  className?: string;
}) {
  const r = resolveImage(input);
  return (
    <div className={`relative overflow-hidden bg-ink ${className}`}>
      {r.kind === 'photo' ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={r.src} alt={alt} loading="lazy" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-ink/60 to-transparent" />
        </>
      ) : (
        <>
          <div className="absolute inset-0 opacity-[0.16]" style={MOTIF_GRID} />
          <div className="absolute inset-4 rounded-md border-2 border-gold-500/50" />
        </>
      )}
      {label && (
        <span className="absolute bottom-2.5 left-3 text-[11px] font-bold uppercase tracking-wider text-white">
          {label}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/consumer/components/SportImage.tsx
git commit -m "feat(consumer): SportImage with scrim + motif fallback"
```

---

# PHASE 3 — Reusable Building Blocks

## Task 3.1: Skeleton + EmptyState + HScroll

**Files:**
- Create: `apps/consumer/components/Skeleton.tsx`, `EmptyState.tsx`, `HScroll.tsx`

- [ ] **Step 1: Skeleton**

Create `apps/consumer/components/Skeleton.tsx`:

```tsx
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`shimmer rounded-card bg-border/60 ${className}`} />;
}

/** A card-shaped skeleton matching VenueCard dimensions. */
export function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-white">
      <Skeleton className="h-[140px] rounded-none" />
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-2/3 rounded" />
        <Skeleton className="h-3 w-1/2 rounded" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: EmptyState**

Create `apps/consumer/components/EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react';

const MOTIF_GRID: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(var(--color-gold-500) 2px, transparent 2px), linear-gradient(90deg, var(--color-gold-500) 2px, transparent 2px)',
  backgroundSize: '26px 26px',
};

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card border border-border bg-white px-6 py-12 text-center">
      <div className="relative mb-4 h-20 w-28 overflow-hidden rounded-md bg-ink">
        <div className="absolute inset-0 opacity-20" style={MOTIF_GRID} />
        <div className="absolute inset-3 rounded border-2 border-gold-500/50" />
      </div>
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-text-secondary">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 3: HScroll**

Create `apps/consumer/components/HScroll.tsx`:

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';

/** A landing-page section: heading + optional "View all" + a horizontal,
 *  scroll-snapping row of cards (peeking next card signals more). */
export function HScroll({
  title,
  viewAllHref,
  children,
}: {
  title: string;
  viewAllHref?: string;
  children: ReactNode;
}) {
  return (
    <section className="py-6">
      <div className="mx-auto mb-3 flex max-w-6xl items-baseline justify-between px-4">
        <h2 className="font-display text-2xl font-semibold text-ink">{title}</h2>
        {viewAllHref && (
          <Link href={viewAllHref} className="text-sm font-semibold text-gold-600 hover:underline">
            View all →
          </Link>
        )}
      </div>
      <div className="mx-auto flex max-w-6xl snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 [scrollbar-width:thin]">
        {children}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/consumer/components/Skeleton.tsx apps/consumer/components/EmptyState.tsx apps/consumer/components/HScroll.tsx
git commit -m "feat(consumer): Skeleton, EmptyState, HScroll primitives"
```

## Task 3.2: API types + format helper

**Files:**
- Modify: `apps/consumer/lib/api/types.ts`, `apps/consumer/lib/format.ts`

- [ ] **Step 1: Add `imageUrl` + cross-venue shapes**

In `apps/consumer/lib/api/types.ts`, add `imageUrl` to `PublicVenue`:

```ts
export interface PublicVenue {
  id: string;
  name: string;
  tags: string[];
  lat: number | null;
  lng: number | null;
  addressJson: Record<string, unknown> | null;
  /** Future uploaded cover photo (backend deferred); undefined until then. */
  imageUrl?: string | null;
}
```

and append these shapes (returned by the new §12 endpoints):

```ts
/** An event plus its owning venue's name + tags (for the card image). */
export interface PublicEventWithVenue extends PublicEvent {
  venueName: string;
  venueTags: string[];
}

/** A membership plus the scope it applies to (venue name, or brand name for
 *  tenant-wide) and the venue tags used to resolve its card image. */
export interface PublicMembershipWithScope extends PublicMembership {
  scopeName: string;
  venueTags: string[];
}
```

- [ ] **Step 2: Add a day/month formatter for event date badges**

Append to `apps/consumer/lib/format.ts`:

```ts
const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'short' });

/** Split an ISO date into a date-badge pair, e.g. { day: "14", month: "Jun" }. */
export function formatDayMonth(iso: string): { day: string; month: string } {
  const d = new Date(iso);
  return { day: dayFmt.format(d), month: monthFmt.format(d) };
}

const weekdayFmt = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long', day: 'numeric', month: 'short',
});

/** A day divider label, e.g. "Saturday, 14 Jun". */
export function formatDayLabel(iso: string): string {
  return weekdayFmt.format(new Date(iso));
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/consumer/lib/api/types.ts apps/consumer/lib/format.ts
git commit -m "feat(consumer): cross-venue API types + date-badge formatters"
```

## Task 3.3: Cross-venue query hooks

**Files:**
- Modify: `apps/consumer/lib/api/consumer.ts`

- [ ] **Step 1: Add the two new hooks**

In `apps/consumer/lib/api/consumer.ts`, add `PublicEventWithVenue` and `PublicMembershipWithScope` to the type import, then add (after `useVenueMemberships`):

```ts
/** All upcoming events across venues (server hides past + sorts ascending). */
export function useUpcomingEvents(limit = 50) {
  return useQuery({
    queryKey: ['events', limit],
    queryFn: () =>
      apiFetch<{ rows: PublicEventWithVenue[] }>(`/v1/consumer/events?limit=${limit}`),
    select: (data) => data.rows,
  });
}

/** All active memberships across venues. */
export function useAllMemberships(limit = 50) {
  return useQuery({
    queryKey: ['memberships', limit],
    queryFn: () =>
      apiFetch<{ rows: PublicMembershipWithScope[] }>(`/v1/consumer/memberships?limit=${limit}`),
    select: (data) => data.rows,
  });
}
```

- [ ] **Step 2: Add a `limit` arg to `useVenues`**

Change the `useVenues` signature so the landing row can request fewer:

```ts
export function useVenues(search: string, limit = 50) {
```
and in its body change `qs.set('limit', '50');` → `qs.set('limit', String(limit));` and the queryKey to `['venues', trimmed, limit]`.

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/consumer/lib/api/consumer.ts
git commit -m "feat(consumer): useUpcomingEvents + useAllMemberships hooks"
```

## Task 3.4: Card compositions (Venue, Event, Membership)

**Files:**
- Create: `apps/consumer/components/cards/VenueCard.tsx`, `EventCard.tsx`, `MembershipCard.tsx`

- [ ] **Step 1: VenueCard**

Create `apps/consumer/components/cards/VenueCard.tsx`:

```tsx
import Link from 'next/link';
import { SportImage } from '@/components/SportImage';
import { Badge } from '@/lib/ui';
import { matchSport } from '@/lib/sportImages';
import type { PublicVenue } from '@/lib/api/types';

function cityOf(addressJson: Record<string, unknown> | null): string | null {
  const c = addressJson?.['city'];
  return typeof c === 'string' && c ? c : null;
}

export function VenueCard({ venue, className = '' }: { venue: PublicVenue; className?: string }) {
  const sport = matchSport(venue.tags);
  const city = cityOf(venue.addressJson);
  return (
    <Link
      href={`/venues/${venue.id}`}
      className={`block overflow-hidden rounded-card border border-border bg-white transition-all hover:-translate-y-1 hover:shadow-[0_16px_36px_rgba(15,28,46,0.16)] ${className}`}
    >
      <SportImage
        input={{ imageUrl: venue.imageUrl, tags: venue.tags }}
        alt={`${venue.name}${sport ? ` — ${sport}` : ''}`}
        label={sport ?? undefined}
        className="h-[140px]"
      />
      <div className="p-4">
        <h3 className="font-display text-[19px] font-semibold text-ink">{venue.name}</h3>
        {city && <p className="mt-0.5 text-sm text-text-secondary">{city}</p>}
        {venue.tags.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {venue.tags.slice(0, 3).map((t) => (
              <Badge key={t} tone="sport" label={t} />
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: EventCard**

Create `apps/consumer/components/cards/EventCard.tsx`:

```tsx
import Link from 'next/link';
import { SportImage } from '@/components/SportImage';
import { formatDayMonth, formatTime, formatPaise } from '@/lib/format';
import type { PublicEventWithVenue } from '@/lib/api/types';

export function EventCard({ event, className = '' }: { event: PublicEventWithVenue; className?: string }) {
  const { day, month } = formatDayMonth(event.startsAt);
  return (
    <Link
      href={`/venues/${event.venueId}`}
      className={`block overflow-hidden rounded-card border border-border bg-white transition-all hover:-translate-y-1 hover:shadow-[0_16px_36px_rgba(15,28,46,0.16)] ${className}`}
    >
      <div className="relative">
        <SportImage
          input={{ tags: event.venueTags }}
          alt={`${event.name} at ${event.venueName}`}
          className="h-[140px]"
        />
        <div className="absolute left-2.5 top-2.5 rounded-lg bg-white px-2.5 py-1 text-center leading-none shadow-md">
          <div className="font-display text-lg font-bold text-ink">{day}</div>
          <div className="text-[9px] font-bold uppercase tracking-widest text-gold-600">{month}</div>
        </div>
      </div>
      <div className="p-4">
        <h3 className="font-display text-[18px] font-semibold text-ink">{event.name}</h3>
        <p className="mt-0.5 text-sm text-text-secondary">
          {event.venueName} · {formatTime(event.startsAt)}
        </p>
        <p className="mt-2 text-sm font-semibold text-ink">{formatPaise(event.pricePaise)}</p>
      </div>
    </Link>
  );
}
```

- [ ] **Step 3: MembershipCard (inverted navy/gold)**

Create `apps/consumer/components/cards/MembershipCard.tsx`:

```tsx
import Link from 'next/link';
import { formatPaise } from '@/lib/format';
import type { PublicMembershipWithScope } from '@/lib/api/types';

export function MembershipCard({
  membership,
  className = '',
}: {
  membership: PublicMembershipWithScope;
  className?: string;
}) {
  const href = membership.venueId ? `/venues/${membership.venueId}` : '/venues';
  return (
    <Link
      href={href}
      className={`block rounded-card border border-ink-soft bg-gradient-to-br from-ink to-ink-soft p-4 text-white transition-all hover:-translate-y-1 ${className}`}
    >
      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-gold-500">
        {membership.scopeName}
      </p>
      <h3 className="font-display text-[19px] font-semibold">{membership.name}</h3>
      {membership.description && (
        <p className="mt-1 line-clamp-2 text-xs text-white/70">{membership.description}</p>
      )}
      <div className="mt-3 font-display text-2xl font-semibold">
        {formatPaise(membership.pricePaise)}{' '}
        <span className="font-sans text-xs text-white/70">/ {membership.durationDays} days</span>
      </div>
      <span className="mt-3 inline-block rounded-lg bg-gold-500 px-3.5 py-1.5 text-xs font-bold text-ink">
        View
      </span>
    </Link>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/consumer/components/cards/
git commit -m "feat(consumer): Venue/Event/Membership card compositions"
```

---

# PHASE 4 — Header, Pages & Route Reshuffle

## Task 4.1: Restyle the Header (navy + gold, Venues/Events nav)

**Files:**
- Modify: `apps/consumer/components/Header.tsx`

- [ ] **Step 1: Replace the header markup**

Replace `apps/consumer/components/Header.tsx` with:

```tsx
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button } from '@/lib/ui';

export function Header() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();

  return (
    <header className="bg-ink text-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="font-display text-xl font-semibold text-white">
          Cir<span className="text-gold-500">cls</span>
        </Link>
        <nav className="flex items-center gap-2 sm:gap-4">
          <Link href="/venues" className="hidden text-sm text-white/80 hover:text-white sm:inline">Venues</Link>
          <Link href="/events" className="hidden text-sm text-white/80 hover:text-white sm:inline">Events</Link>
          {loading ? null : user ? (
            <>
              <Link href="/me/bookings" className="text-sm text-white/80 hover:text-white">My bookings</Link>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => { await signOut(); router.replace('/'); }}
              >
                Sign out
              </Button>
            </>
          ) : (
            <Link href="/login"><Button variant="accent" size="sm">Sign in</Button></Link>
          )}
        </nav>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/consumer/components/Header.tsx
git commit -m "feat(consumer): navy/gold header with Venues/Events nav"
```

## Task 4.2: Move the venue grid to `/venues`

**Files:**
- Create: `apps/consumer/app/venues/page.tsx`

- [ ] **Step 1: Create the venues listing page**

Create `apps/consumer/app/venues/page.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { VenueCard } from '@/components/cards/VenueCard';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useVenues } from '@/lib/api/consumer';
import { Input } from '@/lib/ui';

export default function VenuesPage() {
  const [search, setSearch] = useState('');
  const venues = useVenues(search);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8 max-w-xl">
          <h1 className="font-display text-3xl font-semibold text-ink">Find a venue</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Book courts and turfs, join events, and grab memberships near you.
          </p>
          <div className="mt-4">
            <Input
              placeholder="Search by name or sport…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search venues"
            />
          </div>
        </div>

        {venues.isLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : venues.isError ? (
          <p className="text-sm text-red-600">
            {venues.error instanceof Error ? venues.error.message : 'Failed to load venues'}
          </p>
        ) : !venues.data || venues.data.length === 0 ? (
          <EmptyState title="No venues found" body="Try a different search, or check back soon — new venues are added often." />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {venues.data.map((v) => <VenueCard key={v.id} venue={v} />)}
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/consumer/app/venues/page.tsx
git commit -m "feat(consumer): venues listing page at /venues"
```

## Task 4.3: Landing page at `/`

**Files:**
- Modify: `apps/consumer/app/page.tsx`

- [ ] **Step 1: Replace the home page with the landing page**

Replace `apps/consumer/app/page.tsx` with:

```tsx
'use client';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { HScroll } from '@/components/HScroll';
import { VenueCard } from '@/components/cards/VenueCard';
import { EventCard } from '@/components/cards/EventCard';
import { MembershipCard } from '@/components/cards/MembershipCard';
import { useVenues, useUpcomingEvents, useAllMemberships } from '@/lib/api/consumer';
import { Button } from '@/lib/ui';

const MOTIF: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(var(--color-gold-500) 2px, transparent 2px), linear-gradient(90deg, var(--color-gold-500) 2px, transparent 2px)',
  backgroundSize: '46px 46px',
};

export default function LandingPage() {
  const venues = useVenues('', 10);
  const events = useUpcomingEvents(10);
  const memberships = useAllMemberships(10);

  return (
    <div className="min-h-screen">
      <Header />

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-ink-deep to-ink-soft text-white">
        <div className="absolute inset-0 opacity-10" style={MOTIF} />
        <div className="relative mx-auto max-w-6xl px-4 py-16 sm:py-20">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-gold-500">Welcome to Circls</p>
          <h1 className="max-w-2xl font-display text-4xl font-semibold leading-[1.05] sm:text-5xl">
            Find your circle. <span className="text-gold-500">Book your spot.</span>
          </h1>
          <p className="mt-3 max-w-lg text-base text-white/80">
            Because “we should do this sometime” deserves an actual time.
          </p>
          <div className="mt-6 flex gap-3">
            <Link href="/venues"><Button variant="accent">Browse venues</Button></Link>
            <Link href="/events"><Button variant="secondary">See what&apos;s on →</Button></Link>
          </div>
        </div>
      </section>

      <main className="py-6">
        {(venues.data?.length ?? 0) > 0 && (
          <HScroll title="Venues near you" viewAllHref="/venues">
            {venues.data!.map((v) => <VenueCard key={v.id} venue={v} className="w-[260px] shrink-0 snap-start" />)}
          </HScroll>
        )}

        {(events.data?.length ?? 0) > 0 && (
          <HScroll title="Upcoming events" viewAllHref="/events">
            {events.data!.map((e) => <EventCard key={e.id} event={e} className="w-[260px] shrink-0 snap-start" />)}
          </HScroll>
        )}

        {(memberships.data?.length ?? 0) > 0 && (
          <HScroll title="Memberships">
            {memberships.data!.map((m) => <MembershipCard key={m.id} membership={m} className="w-[260px] shrink-0 snap-start" />)}
          </HScroll>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/consumer/app/page.tsx
git commit -m "feat(consumer): landing page with hero + 3 scroll rows"
```

## Task 4.4: Events listing page at `/events`

**Files:**
- Create: `apps/consumer/app/events/page.tsx`

- [ ] **Step 1: Create the events listing (grouped by day, upcoming only)**

Create `apps/consumer/app/events/page.tsx`:

```tsx
'use client';
import { Header } from '@/components/Header';
import { EventCard } from '@/components/cards/EventCard';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useUpcomingEvents } from '@/lib/api/consumer';
import { formatDayLabel } from '@/lib/format';
import type { PublicEventWithVenue } from '@/lib/api/types';

/** Group events (already ascending) by calendar day for date dividers. */
function groupByDay(rows: PublicEventWithVenue[]): { label: string; events: PublicEventWithVenue[] }[] {
  const groups: { label: string; events: PublicEventWithVenue[] }[] = [];
  for (const ev of rows) {
    const label = formatDayLabel(ev.startsAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.events.push(ev);
    else groups.push({ label, events: [ev] });
  }
  return groups;
}

export default function EventsPage() {
  const events = useUpcomingEvents(100);
  // Defensive guard: never show a past event even if the API regresses.
  const now = Date.now();
  const upcoming = (events.data ?? []).filter((e) => new Date(e.endsAt).getTime() >= now);
  const groups = groupByDay(upcoming);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-1 font-display text-3xl font-semibold text-ink">What&apos;s on</h1>
        <p className="mb-8 text-sm text-text-secondary">Upcoming events across every venue.</p>

        {events.isLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : events.isError ? (
          <p className="text-sm text-red-600">
            {events.error instanceof Error ? events.error.message : 'Failed to load events'}
          </p>
        ) : upcoming.length === 0 ? (
          <EmptyState title="Nothing on right now" body="There are no upcoming events yet. Check back soon — new ones drop all the time." />
        ) : (
          <div className="space-y-8">
            {groups.map((g) => (
              <div key={g.label}>
                <h2 className="mb-3 font-display text-lg font-semibold text-ink">{g.label}</h2>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {g.events.map((e) => <EventCard key={e.id} event={e} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/consumer/app/events/page.tsx
git commit -m "feat(consumer): events listing page (upcoming, grouped by day)"
```

## Task 4.5: Restyle venue detail, bookings, login

**Files:**
- Modify: `apps/consumer/app/venues/[venueId]/page.tsx`, `app/me/bookings/page.tsx`, `app/login/page.tsx`

- [ ] **Step 1: Venue detail — hero banner + restyle**

In `apps/consumer/app/venues/[venueId]/page.tsx`:

(a) Add imports at the top:
```tsx
import { SportImage } from '@/components/SportImage';
import { matchSport } from '@/lib/sportImages';
```
(b) Widen the main container: `max-w-4xl` → `max-w-5xl`.
(c) Replace the venue title block (the `<div className="mb-6">…</div>` containing the `h1`, tags, and `AddressLine`) with a hero banner:
```tsx
            <div className="mb-6 overflow-hidden rounded-card border border-border">
              <SportImage
                input={{ imageUrl: venueQ.data.venue.imageUrl, tags: venueQ.data.venue.tags }}
                alt={venueQ.data.venue.name}
                label={matchSport(venueQ.data.venue.tags) ?? undefined}
                className="h-44 sm:h-56"
              />
              <div className="bg-white p-5">
                <h1 className="font-display text-3xl font-semibold text-ink">{venueQ.data.venue.name}</h1>
                {venueQ.data.venue.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {venueQ.data.venue.tags.map((tag) => (
                      <Badge key={tag} tone="sport" label={tag} />
                    ))}
                  </div>
                )}
                <AddressLine addressJson={venueQ.data.venue.addressJson} />
              </div>
            </div>
```
(d) For each section heading, change `text-[#0f172a]` → `font-display text-ink` and keep sizes. (e) In `ArenaCard`'s slot buttons, change the hover classes `hover:border-brand-400 hover:bg-brand-50` → `hover:border-gold-500 hover:bg-gold-100`. (f) Replace remaining hard-coded grays: `text-[#475569]`→`text-text-secondary`, `text-[#0f172a]`→`text-ink`, `border-[#e5e7eb]`→`border-border` throughout this file.

- [ ] **Step 2: Bookings — Premium type + tokens**

In `apps/consumer/app/me/bookings/page.tsx`: change the `h1` to `className="mb-6 font-display text-3xl font-semibold text-ink"`; replace `text-[#475569]`→`text-text-secondary` and `text-[#0f172a]`→`text-ink`; change the booking card venue name `h2` to add `font-display`; replace the empty `<Card>` with `<EmptyState title="No bookings yet" body="When you book a court, join an event, or buy a membership, it'll show up here." />` (add `import { EmptyState } from '@/components/EmptyState';`).

- [ ] **Step 3: Login — serif heading + warm background**

In `apps/consumer/app/login/page.tsx`: the `Card title="Sign in"` renders via the Card primitive; no change needed beyond tokens. Change the `error` paragraph `text-red-600` stays. Add a serif touch: above the `<Card>` add `<h1 className="mb-4 text-center font-display text-2xl font-semibold text-ink">Welcome back</h1>`.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck` → PASS.
Run: `pnpm build` → PASS (compiles all routes).

- [ ] **Step 5: Commit**

```bash
git add apps/consumer/app/venues/\[venueId\]/page.tsx apps/consumer/app/me/bookings/page.tsx apps/consumer/app/login/page.tsx
git commit -m "feat(consumer): restyle venue detail, bookings, login"
```

---

# PHASE 5 — Footer & Legal Pages

## Task 5.1: Footer

**Files:**
- Create: `apps/consumer/components/Footer.tsx`

- [ ] **Step 1: Implement the footer**

Create `apps/consumer/components/Footer.tsx`:

```tsx
import Link from 'next/link';

const LINKS = [
  { href: '/venues', label: 'Venues' },
  { href: '/events', label: 'Events' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'Terms & Conditions' },
  { href: '/refund', label: 'Refund Policy' },
];

export function Footer() {
  return (
    <footer className="bg-ink-deep text-white/70">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/" className="font-display text-xl text-white">
            Cir<span className="text-gold-500">cls</span>
          </Link>
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="text-white/80 hover:text-white">{l.label}</Link>
            ))}
            <a href="mailto:support@gibbous.io" className="text-white/80 hover:text-white">Contact</a>
          </nav>
        </div>
        <div className="mt-5 border-t border-white/10 pt-4 text-xs leading-relaxed">
          <p className="text-white/80">© 2026 Gibbous.io. All rights reserved.</p>
          <p className="mt-1">
            Gibbous Technologies Private Limited · GSTIN 27AALCG2506R1Z3 · Pune, Maharashtra, India · support@gibbous.io
          </p>
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 2: Confirm it's wired in `layout.tsx`** (added in Task 1.2). Typecheck.

Run: `pnpm typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/consumer/components/Footer.tsx
git commit -m "feat(consumer): site-wide footer with legal links"
```

## Task 5.2: Legal layout + content modules

**Files:**
- Create: `apps/consumer/components/legal/LegalLayout.tsx`
- Create: `apps/consumer/lib/legal/types.ts`, `privacy.ts`, `terms.ts`, `refund.ts`

**Source of truth (transcribe verbatim — do NOT paraphrase legal text):**
- `~/personal/circls/apps/circls_web/lib/src/screens/privacy/privacy_screen.dart`
- `~/personal/circls/apps/circls_web/lib/src/screens/terms/terms_screen.dart`
- `~/personal/circls/apps/circls_web/lib/src/screens/refund/refund_screen.dart`

- [ ] **Step 1: Define the content data shape**

Create `apps/consumer/lib/legal/types.ts`:

```ts
export interface LegalSection {
  /** Optional group divider shown before this section, e.g. "Your Rights". */
  group?: string;
  number?: number;
  title: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface LegalDoc {
  slug: 'privacy' | 'terms' | 'refund';
  title: string;
  updated: string; // "12 May 2026"
  intro: string;
  sections: LegalSection[];
}
```

- [ ] **Step 2: Transcribe the three documents**

Create `apps/consumer/lib/legal/privacy.ts`, `terms.ts`, `refund.ts`, each exporting a `LegalDoc`. Open each Dart source above and copy every section's title, paragraphs, bullets, and group label **verbatim** into the `sections` array, in order. Use these constants exactly:
- `updated: '12 May 2026'` for all three.
- Privacy `intro`: the first paragraph beginning "By visiting circls.app, you agree to the following terms regarding the collection and use of your data…".
- Terms: include Section 20 (Merchant Information) verbatim — entity **Gibbous Technologies Private Limited**, **GSTIN 27AALCG2506R1Z3**, Pune registered office + Nagpur office.
- Refund: the eligibility grid and timeline render as ordinary bullets in their respective sections (the "non-refundable / potentially eligible" items as bullets; the "48 hrs / 48 hrs / 7–10 business days" items as bullets) — do not build bespoke grid widgets.

Example shape (privacy.ts — fill `sections` from the Dart source):

```ts
import type { LegalDoc } from './types';

export const PRIVACY: LegalDoc = {
  slug: 'privacy',
  title: 'Privacy Policy',
  updated: '12 May 2026',
  intro:
    'By visiting circls.app, you agree to the following terms regarding the collection and use of your data. …', // copy full paragraph verbatim
  sections: [
    {
      group: 'Data Collection & Usage',
      number: 1,
      title: 'Information We Collect', // exact title from source
      paragraphs: [
        'When you visit circls.app, we may automatically collect certain information such as your IP address, device type, browser type, operating system, and browsing activity on our site. …', // verbatim
      ],
    },
    // … all remaining sections, in order, verbatim
  ],
};
```

- [ ] **Step 3: LegalLayout component**

Create `apps/consumer/components/legal/LegalLayout.tsx`:

```tsx
import Link from 'next/link';
import { Header } from '@/components/Header';
import type { LegalDoc } from '@/lib/legal/types';

const TABS: { slug: string; label: string }[] = [
  { slug: 'privacy', label: 'Privacy' },
  { slug: 'terms', label: 'Terms' },
  { slug: 'refund', label: 'Refund' },
];

export function LegalLayout({ doc }: { doc: LegalDoc }) {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-[11px] font-bold uppercase tracking-widest text-gold-600">
          Circls · Gibbous Technologies Private Limited
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink">{doc.title}</h1>
        <p className="mt-1 text-sm text-text-secondary">Last updated {doc.updated}</p>
        <p className="mt-1 text-sm text-text-secondary">
          Contact: Contact@gibbous.io · Jurisdiction: Nagpur, Maharashtra, India
        </p>

        <nav className="mt-5 flex gap-2">
          {TABS.map((t) => (
            <Link
              key={t.slug}
              href={`/${t.slug}`}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                t.slug === doc.slug ? 'bg-ink text-white' : 'bg-gold-100 text-gold-text hover:bg-gold-100/70'
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        <div className="mt-6 rounded-card border border-border bg-white p-5 text-sm leading-relaxed text-ink/90">
          {doc.intro}
        </div>

        <div className="mt-8 space-y-8">
          {doc.sections.map((s, i) => (
            <section key={i}>
              {s.group && (
                <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-text-muted">{s.group}</p>
              )}
              <h2 className="font-display text-lg font-semibold text-ink">
                {s.number != null ? `${s.number}. ` : ''}{s.title}
              </h2>
              {s.paragraphs.map((p, j) => (
                <p key={j} className="mt-2 text-sm leading-relaxed text-ink/90">{p}</p>
              ))}
              {s.bullets && s.bullets.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink/90">
                  {s.bullets.map((b, k) => <li key={k}>{b}</li>)}
                </ul>
              )}
            </section>
          ))}
        </div>

        <div className="mt-10 rounded-card border border-border bg-gold-100/40 p-5 text-sm text-ink">
          Questions? Reach us at <a className="font-semibold underline" href="mailto:Contact@gibbous.io">Contact@gibbous.io</a>.
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/consumer/components/legal/ apps/consumer/lib/legal/
git commit -m "feat(consumer): legal layout + transcribed policy content"
```

## Task 5.3: Legal route pages

**Files:**
- Create: `apps/consumer/app/privacy/page.tsx`, `app/terms/page.tsx`, `app/refund/page.tsx`

- [ ] **Step 1: Create the three pages**

Create `apps/consumer/app/privacy/page.tsx`:
```tsx
import { LegalLayout } from '@/components/legal/LegalLayout';
import { PRIVACY } from '@/lib/legal/privacy';

export const metadata = { title: 'Privacy Policy — Circls' };
export default function PrivacyPage() { return <LegalLayout doc={PRIVACY} />; }
```

Create `apps/consumer/app/terms/page.tsx`:
```tsx
import { LegalLayout } from '@/components/legal/LegalLayout';
import { TERMS } from '@/lib/legal/terms';

export const metadata = { title: 'Terms & Conditions — Circls' };
export default function TermsPage() { return <LegalLayout doc={TERMS} />; }
```

Create `apps/consumer/app/refund/page.tsx`:
```tsx
import { LegalLayout } from '@/components/legal/LegalLayout';
import { REFUND } from '@/lib/legal/refund';

export const metadata = { title: 'Refund Policy — Circls' };
export default function RefundPage() { return <LegalLayout doc={REFUND} />; }
```

- [ ] **Step 2: Full build**

Run: `pnpm typecheck` → PASS.
Run: `pnpm build` → PASS (all routes including `/privacy`, `/terms`, `/refund`).

- [ ] **Step 3: Commit**

```bash
git add apps/consumer/app/privacy/ apps/consumer/app/terms/ apps/consumer/app/refund/
git commit -m "feat(consumer): privacy, terms, refund pages"
```

---

# PHASE 6 — Verification

## Task 6.1: Full test + build + visual pass

- [ ] **Step 1: Unit tests + typecheck + build**

Run (from `apps/consumer/`): `pnpm test && pnpm typecheck && pnpm build`
Expected: tests PASS, typecheck PASS, build PASS.

- [ ] **Step 2: Manual visual pass**

Run `pnpm dev` (port 3003) and verify against `NEXT_PUBLIC_API_BASE_URL` pointing at a live API:
- `/` landing — hero copy correct; rows appear only when populated; rows scroll horizontally.
- `/venues` — grid; skeletons while loading; EmptyState when none; only venues with bookable arenas appear (depends on §12.1 being live).
- `/events` — grouped by day, ascending; **no past event appears** (verify with a known past event); EmptyState when none.
- `/venues/[id]` — hero banner (photo for a sport-tagged venue, motif for an untagged one); slot/event/membership sections styled.
- `/me/bookings`, `/login` — restyled.
- `/privacy`, `/terms`, `/refund` — content renders, tabs switch, footer legal line correct.
- Toggle OS "reduce motion" → hover/shimmer transitions disabled.

- [ ] **Step 3: Note API dependency**

If the new endpoints (`GET /v1/consumer/events`, `/memberships`) and §12.1 filter are not yet deployed, the events row/page and memberships row will be empty and venues may include arena-less venues. This is expected until the API agent ships §12. Record which surfaces are blocked on the API in the PR description.

---

## API Handoff Reminder (separate agent — spec §12)

This plan consumes, but does not implement, these backend changes in
`apps/api/src/services/consumer_service.ts` + `routes/consumer.ts`:

1. **§12.1** `listPublicVenues`: only venues with ≥1 `status='active'` arena.
2. **§12.2** `listPublicEvents(venueId)`: add `ends_at >= now()`, `order by starts_at asc`.
3. **§12.3** New `GET /v1/consumer/events?limit=` → published, future, all-venue events
   ascending, each with `venueName` + `venueTags`.
4. **§12.4** New `GET /v1/consumer/memberships?limit=` → active memberships across venues,
   each with `venueId`, `scopeName`, `venueTags`.

All must preserve the existing approval + tenant-active visibility rule.
```
