# Schedule Builder — Pricing Bands, Business-Day Window & Overnight/24h Support

**Date:** 2026-06-18
**Status:** Approved design (background session; directional answers captured)
**Area:** `apps/partners` schedule builder + shared Matrix grid + `apps/api` arenas/slots

## Problem

The current schedule builder (`apps/partners/app/(protected)/arenas/[arenaId]/schedule/page.tsx`)
only lets a partner set a single uniform daily open/close time and one default price,
then drag-select cells in the grid to reprice. Three concrete pain points:

1. **No intuitive multi-band pricing.** Expressing "6–10am @ ₹X, 10am–4pm @ ₹Y,
   4pm–2am @ ₹Z" requires manual drag-selection of grid rows.
2. **Business day ≠ calendar day.** Many venues operate past midnight. The day should
   run from a configurable boundary (default **3am → 3am next day**, a 3-hour buffer)
   so a late band like 4pm–2am reads contiguously instead of wrapping into the next column.
3. **Overnight / 24h impossible.** Validation `parseTimeToMin(open) >= parseTimeToMin(close)`
   rejects any window where end ≤ start, so 4pm–2am and a 24-hour (3am→3am) window both error.

## Key finding

The **backend already supports** everything needed for overnight/24h slots:

- `releaseSlotsSchema` accepts arbitrary `cells[]` of `{dayOfWeek, startTimeMin, durationMin, price, blocked}`.
- `localMinutesToUtcIso(dateStr, localMinutes, tz)` correctly handles `localMinutes ≥ 1440`
  (it is linear arithmetic from the date's local midnight), so a slot anchored to a
  business day with `startTimeMin = 1500` lands at 1am the next calendar day.

Therefore **no change to the slot-creation math is required**. All blockers are in the
frontend builder UI, its validation, and the shared grid's row-ordering / day-bucketing.

## Decisions (captured)

- **Bands apply to all 7 days uniformly.** Per-day differences are handled by editing
  individual cells in the preview grid before release (existing capability).
- **Bands quantize into sub-slots.** A band of length L with quantization Q produces
  ⌈coverage⌉ bookable slots each priced at the band price. Preserves the existing
  slot/booking model unchanged.
- **Business-day-start is configurable, default 3am (180 min).**
- **Preview grid stays.** Bands are the primary input; the grid renders for verification
  and per-cell fine-tuning/blocking before release.
- **Last-used bands are remembered.** Persisted per arena; the builder prefills them so
  the user only changes the date range and hits Generate.

## Band model (pure, unit-tested)

A `Band` is `{ startMin: number; endMin: number; priceRupees: number }`, where
`startMin`/`endMin` are minutes-from-midnight in `[0, 1440)` (venue wall clock).

Given `dayStartMin` (e.g. 180):

```
offset(t)      = (t - dayStartMin + 1440) % 1440        // position within business day, 0..1439
startOffset    = offset(startMin)
endOffset      = offset(endMin)
if endOffset <= startOffset: endOffset += 1440          // wraps past midnight; also 24h when endMin===startMin
bandLengthMin  = endOffset - startOffset                // in (0, 1440]
```

- `endMin === startMin` ⇒ `endOffset = startOffset + 1440` ⇒ a full **24-hour** band.
  (A zero-length band is meaningless, so start===end is unambiguously "all day".)
- **Validation:** sort bands by `startOffset`; reject overlaps (each band's `endOffset`
  must be ≤ the next band's `startOffset`); reject `bandLengthMin > 1440`; reject invalid
  prices. Gaps between bands are allowed (no slots created there).

### Band → release cells

For each band and each `dayOfWeek` 0..6, step from `startOffset` to `endOffset` by
`quantizationMin`:

```
for o in [startOffset, endOffset) step quantizationMin:
  step = min(quantizationMin, endOffset - o)            // clamp final partial slot
  cell = {
    dayOfWeek,
    startTimeMin: dayStartMin + o,                       // LINEAR — may exceed 1440 for overnight
    durationMin:  step,
    price:        priceRupees * 100,                     // paise
    blocked:      false,
  }
```

Keeping `startTimeMin` linear (not mod 1440) is what makes an overnight slot anchor to the
business day that *owns* it: a 1am slot in Monday's business day is emitted as
`{dayOfWeek: Mon, startTimeMin: 1500}`, which `localMinutesToUtcIso` resolves to Tuesday 1am.
The backend's per-date weekday match then creates it exactly once.

**Range-edge nuance (documented, accepted):** with `dayStartMin = 180`, the slots between
midnight and 3am of `startDate` belong to the *previous* business day and are not created
(that day is before the range). Symmetric at the end: the final business day extends past
midnight into `endDate + 1`. This is the intended business-day range semantics.

## Persistence (apps/api)

Add to `arenas` table (new migration):

- `business_day_start_min integer NOT NULL DEFAULT 180`
- `schedule_template jsonb` (nullable)

`schedule_template` shape (last-used builder config):

```json
{
  "quantizationMin": 60,
  "defaultPriceRupees": 500,
  "bands": [
    { "startMin": 360, "endMin": 600, "priceRupees": 400 },
    { "startMin": 600, "endMin": 960, "priceRupees": 600 },
    { "startMin": 960, "endMin": 120, "priceRupees": 800 }
  ]
}
```

- `business_day_start_min` is a first-class column (reception reads it without parsing JSON).
- The **release service** writes both `business_day_start_min` and `schedule_template` to the
  arena inside the release transaction, so "last used = last released".
- `GET /v1/arenas/:id` returns both fields; partners `Arena` type and `useArena` gain them.
- Consumer-facing arena mapping is unaffected (does not expose these).
- Zod: extend the release request (or add a sibling field) to carry `businessDayStartMin`
  and the band template so the server can persist it. Slot creation still uses `cells[]`.

## Builder UI (apps/partners schedule/page.tsx)

Replace the single open/close/default-price controls with:

- **Date range** (unchanged).
- **Business day starts at** — time input, default from `arena.businessDayStartMin` (03:00).
- **Quantization** — existing select (30/60/90).
- **Pricing bands** — editable list of rows `{ start time, end time, price ₹ }` with
  add/remove. Prefilled from `arena.scheduleTemplate.bands`. A "+ Add band" control.
- **Generate preview** — validates, expands bands → preview slots, renders the grid.
- **Release** — sends `{ startDate, endDate, quantizationMin, cells, businessDayStartMin, template }`.

Validation messages: dates required / ordered; bands non-overlapping; valid non-negative
prices. Wrap-around and 24h bands are valid (no "start < end" error).

## Shared Matrix grid (apps/partners components/Matrix.tsx)

Add optional prop `dayStartMin?: number` (**default 0** ⇒ byte-for-byte current behavior;
zero regression risk for any caller not passing it).

When `dayStartMin > 0`:

- **Row order:** sort the unique time-key rows by business-day offset
  `(parseHHMM(key) - dayStartMin + 1440) % 1440` instead of lexically — so rows read
  03:00, 04:00, …, 23:00, 00:00, 01:00, 02:00.
- **Column bucketing:** `getDayIndex` shifts the slot instant back by `dayStartMin` minutes
  before computing its weekday/date in tz, so a 2am slot buckets into the business day that
  owns it. (Relies on the existing non-DST assumption already documented in `slot_service`.)
- Now-line math (`computeNowRowOffset`) already keys off absolute slot start/end instants;
  only row order changes, so it stays correct.

**Callers:**
- Builder passes the configured `dayStartMin`.
- Reception page (`arenas/[arenaId]/page.tsx`) passes `arena.businessDayStartMin` so the
  reception grid matches what was released and overnight slots display under the right day.

## Help docs

Update `apps/partners/content/help/schedule.md` (and `lib/help/articles.ts` summary if the
scope/wording changes) in the same PR: document pricing bands, the configurable business-day
window, and overnight/24-hour scheduling.

## Testing

- **Pure band functions** (new module, e.g. `apps/partners/lib/schedule/bands.ts`):
  offset math, wrap-around, 24h (start===end), overlap validation, band→cells expansion
  including the clamped final partial slot and overnight `startTimeMin ≥ 1440`.
- **Matrix ordering**: rows sorted by business-day offset; column bucketing of an overnight
  slot; `dayStartMin = 0` reproduces current ordering.
- **Backend**: existing `enumerateOccurrences` tests still pass; add a case asserting an
  overnight cell (`startTimeMin = 1500`) produces a next-calendar-day instant on the
  owning weekday. Release persists `business_day_start_min` + `schedule_template`.
- Lint/typecheck/build green.

## Out of scope

- Per-weekday band sets (deferred; grid overrides cover the gap).
- One-slot-per-band booking unit (rejected; keeps slot/booking model intact).
- DST-correct timezone math (pre-existing limitation, unchanged).
