# Ticket Tiers for Events — Design

**Date:** 2026-06-18
**Status:** Approved (pending spec review)
**Repo:** circls-platform

## Summary

Events currently have a single `pricePaise` and a single `capacity`; each event
booking is one ledger row = one seat. This feature replaces that with **ticket
tiers**: a partner defines one or more named, individually-priced, individually-
capped ticket tiers per event. A consumer picks quantities across those tiers on
the event page (a per-event "cart"), reviews a combined total, and checks out in
a single transaction — buying multiple tickets across multiple tiers at once.

### Scope decisions (locked)

- **Consumer target:** web only (`apps/consumer`). Flutter parity is a separate
  follow-up task, explicitly out of scope here.
- **Capacity model:** per-tier capacity only. Each tier carries its own
  `capacity` (null = unlimited). There is no event-level cap for tiered events.
- **Cart scope:** per-event. The consumer selects quantities across the tiers of
  a *single* event and checks out in one transaction. No persistent,
  cross-event cart.
- **Existing events:** auto-migrate. Every existing event is backfilled into one
  default `"General Admission"` tier. All events always have ≥1 tier afterward.
- **Tier editing surface:** tiers are embedded in the event create/update
  payload (replace-all, draft-only) — no separate tier-CRUD endpoints.
- **Free/paid mixing:** tiers may mix free (₹0) and paid in one event. A cart
  total of ₹0 skips Razorpay (existing behaviour).

### Out of scope (explicit)

- Flutter consumer parity (separate follow-up).
- Global, cross-event cart.
- Per-tier coupons. Coupons remain event/venue/org scoped and apply to the
  combined cart base.

## Current state (what we're changing)

- `events` table: `pricePaise bigint`, `capacity int` — single price, single cap.
  (`apps/api/src/db/schema/events.ts`)
- `bookings` table: unified ledger. Event booking = one row, `itemType='event'`,
  `itemData = { eventId, eventName }`, `basePaise`/`totalPaise` for money.
  (`apps/api/src/db/schema/bookings.ts`)
- `bookEvent()` enforces capacity by counting non-cancelled event bookings, then
  computes money via `computeCheckout()` (discount + Razorpay gross-up), inserts
  one booking row, records coupon redemption.
  (`apps/api/src/services/booking_service.ts`)
- `priceItem()` returns `basePaise = ev.pricePaise` for events.
  (`apps/api/src/services/coupon_service.ts`)
- Quote endpoint `POST /v1/consumer/checkout/quote` and book endpoint
  `POST /v1/events/:eventId/book` take no quantity/tier.
  (`apps/api/src/routes/checkout.ts`, `apps/api/src/routes/bookings.ts`)
- Consumer event page shows one price + one "Book" button; `CheckoutModal`
  handles a single item per checkout.
  (`apps/consumer/app/events/[id]/page.tsx`, `apps/consumer/lib/checkout/*`)
- **Precedent:** multi-slot booking already creates ONE booking row covering
  multiple items (one Razorpay order), with the items linked via a child
  relationship (`bookSlots()` claims N slots, one booking). Tiers follow the
  same shape.

## Data model

### New table: `event_ticket_tiers`

| column         | type        | notes                                        |
|----------------|-------------|----------------------------------------------|
| `id`           | uuid PK     |                                              |
| `event_id`     | uuid FK     | → `events.id`, `ON DELETE CASCADE`           |
| `tenant_id`    | uuid FK     | → `tenants.id` (denormalized for scoping)    |
| `name`         | text        | not null, e.g. "Early Bird", "VIP"           |
| `description`  | text        | nullable                                     |
| `price_paise`  | bigint      | not null, default 0 (`bigintPaise`)          |
| `capacity`     | int         | nullable; null = unlimited. Per-tier.        |
| `sort_order`   | int         | not null, default 0; display order           |
| `created_at`   | timestamptz | `createdAt()`                                |
| `updated_at`   | timestamptz | `updatedAt()`                                |
| `deleted_at`   | timestamptz | nullable; soft-delete on draft replace-all   |

Indexes: `(event_id)` for listing a tier set.

### New table: `event_booking_tickets` (booking line items)

| column             | type        | notes                                      |
|--------------------|-------------|--------------------------------------------|
| `id`               | uuid PK     |                                            |
| `booking_id`       | uuid FK     | → `bookings.id`, `ON DELETE CASCADE`       |
| `tier_id`          | uuid FK     | → `event_ticket_tiers.id`                  |
| `quantity`         | int         | not null, CHECK > 0                        |
| `unit_price_paise` | bigint      | not null; price snapshot at purchase       |
| `created_at`       | timestamptz | `createdAt()`                              |

Indexes: `(tier_id)` — drives the per-tier sold count
(`SUM(quantity)` over non-cancelled bookings). `(booking_id)` for reading a
booking's lines.

**Per-tier sold count** =
`SELECT COALESCE(SUM(ebt.quantity),0) FROM event_booking_tickets ebt
 JOIN bookings b ON b.id = ebt.booking_id
 WHERE ebt.tier_id = :tierId AND b.status <> 'cancelled'`.

### Changed: `bookings`

Unchanged structurally. An event booking remains **one row per checkout**:
`itemType='event'`, `itemData = { eventId, eventName }`, `basePaise` =
Σ(unitPrice × qty) across lines, `totalPaise` grossed up, optional `couponId`.
The per-tier breakdown lives in `event_booking_tickets`. One booking → one
Razorpay order, exactly as multi-slot works today.

### Changed: `events`

`price_paise` and `capacity` become **legacy** columns — kept (not dropped, to
avoid a risky destructive migration), but no longer the source of truth for
pricing or capacity. To keep the events *list* cheap, `events.price_paise` is
maintained as the **min tier price** ("from ₹X") whenever an event's tiers are
written. `events.capacity` is unused for tiered events.

## Migration

Single migration file (next number in `apps/api/src/db/migrations/`; do NOT
hardcode the number on the branch — renumber at merge per repo convention).

1. **Schema:** create `event_ticket_tiers` and `event_booking_tickets` with the
   columns/indexes/FKs above (+ `event_booking_tickets.quantity > 0` CHECK).
2. **Data backfill (idempotent within the migration):**
   - For every existing event, insert one tier:
     `name='General Admission'`, `price_paise = events.price_paise`,
     `capacity = events.capacity`, `sort_order = 0`.
   - For every existing **non-cancelled** event booking, insert one
     `event_booking_tickets` line: that event's default tier, `quantity = 1`,
     `unit_price_paise = COALESCE(bookings.base_paise, bookings.price_paise, 0)`.
     This makes per-tier sold counts include legacy bookings so capacity stays
     correct after migration.
   - Re-sync `events.price_paise` to the min tier price (no-op for single-tier).

## Capacity enforcement

In `bookEvent()` (and the online-payment booking path) inside the existing
transaction:

1. Validate every requested line's `tierId` belongs to this event, is not
   soft-deleted, and `quantity > 0`.
2. For each requested tier: `SELECT … FOR UPDATE` the tier row to serialize
   concurrent buyers, then compute the per-tier sold count (query above, inside
   the tx). If `sold + requestedQty > capacity` (and `capacity` is not null) →
   `Conflict('Tier sold out', 'tier_sold_out', { tierId })`.
3. Insert the booking row, then all `event_booking_tickets` lines, then record
   coupon redemption — all atomic. Roll back on any per-tier failure.

This replaces the old `count(*) where itemType='event'` capacity check.

## Pricing & money

- `priceItem()` (event branch) gains an optional `lines: [{tierId, quantity}]`.
  `basePaise = Σ(tier.price_paise × quantity)`; `tenantId`/`venueId` from the
  event (so event/venue/org coupons still match). When called **without** lines
  (the public-coupons listing endpoint, which only needs *a* base to test a
  coupon's `minOrderPaise`), fall back to the **min tier price** — a safe lower
  bound for coupon eligibility.
- `computeCheckout()` is unchanged: it operates on the summed `basePaise`,
  applies the coupon discount, then grosses up for the Razorpay fee. One total,
  one order.

## API changes

### Partner (tenant-scoped, draft-only)

Tiers are embedded in the event payloads — no separate tier endpoints.

- `createEventSchema`, `createTenantEventSchema`, `updateEventSchema` gain
  `tiers: [{ name, description?, pricePaise, capacity? }]`, **min length 1**.
  (`apps/api/src/routes/events.ts`)
- `events_service.createEvent()` / `updateEvent()` write tiers transactionally.
  Update is **replace-all** (soft-delete tiers no longer present, upsert the
  rest) and remains **draft-only** (published events are frozen, as today).
  After writing tiers, re-sync `events.price_paise` to the min tier price.
- `GET /v1/tenants/:tenantId/events/:id` and the bookings/registrations view
  return tiers and per-tier sold counts.

### Consumer

- `GET /v1/consumer/events/:id` returns
  `tiers: [{ id, name, description, pricePaise, capacity, remaining }]`
  (`remaining = capacity - sold`, or null when unlimited).
  (`apps/api/src/services/consumer_service.ts`)
- `POST /v1/consumer/checkout/quote` event variant gains
  `lines: [{ tierId, quantity }]` (min 1). Returns the same breakdown shape
  (base/discount/otherCharges/total/coupon) computed over the summed base.
  (`apps/api/src/routes/checkout.ts`)
- `POST /v1/events/:eventId/book` body gains `lines: [{ tierId, quantity }]`
  (min 1). Validates tiers, quantities, and per-tier capacity (above).
  (`apps/api/src/routes/bookings.ts`)

## UI

### Consumer (web — `apps/consumer`)

- **Event detail** (`app/events/[id]/page.tsx`): render the tier list — each tier
  shows name, description, price, and a quantity stepper. Stepper is capped at
  `remaining`; shows "Sold out" and is disabled when `remaining === 0`. A running
  subtotal updates live. One CTA: "Register" if the selected total is ₹0, else
  "Book" → opens the checkout modal with the selected lines. Disabled until ≥1
  ticket is selected.
- **Checkout** (`lib/checkout/types.ts`, `CheckoutModal.tsx`,
  `CheckoutProvider.tsx`): the event `CheckoutItem` variant carries
  `lines: [{ tierId, tierName, quantity, unitPricePaise }]`. `quoteItem()` and
  `onPay()` pass `lines`. The modal lists per-tier line items
  (name × qty = subtotal) above the existing base/discount/other-charges/total
  rows. Coupon flow unchanged. One Razorpay order for the combined total
  (existing mechanism).

### Partner (`apps/partners`)

- **Event forms + edit pages** — all four:
  `app/(protected)/events/new/page.tsx`,
  `app/(protected)/events/[eventId]/page.tsx`,
  `app/(protected)/venues/[venueId]/events/new/page.tsx`,
  `app/(protected)/venues/[venueId]/events/[eventId]/page.tsx`.
  Replace the single price + capacity inputs with a **repeatable tiers editor**:
  rows of (name, ₹ price, capacity); add/remove; ≥1 required; client-side
  validation. Editing only enabled while the event is `draft`.
- **Registrations view**: show per-tier sold counts alongside the registrant
  list.

### Help docs (same PR — repo rule)

- Update `apps/partners/content/help/events.md`: document defining ticket tiers,
  per-tier pricing and capacity, and consumers buying multiple tickets across
  tiers. Check `apps/partners/lib/help/articles.ts` for a summary/metadata
  update. No new article needed (this extends the existing events article).

## Error handling

- `tier_sold_out` (409, with `tierId`) — requested quantity exceeds a tier's
  remaining capacity (checked under row lock). Consumer modal surfaces "That
  tier just sold out — adjust quantities."
- `bad_request` — empty `lines`, `quantity ≤ 0`, `tierId` not belonging to the
  event, or an event create/update with zero tiers.
- `event_not_published` / `event_not_found` — unchanged.
- Coupon errors — unchanged (operate on combined base).

## Testing

- **Migration:** existing event → one default tier with matching price/capacity;
  existing non-cancelled booking → one line; `events.price_paise` = min tier.
- **Event create/update:** ≥1 tier enforced; replace-all on draft update;
  published events reject tier edits.
- **Quote:** multi-tier `lines` sum to correct base; coupon applies to combined
  base; min-tier fallback for the coupons-listing endpoint.
- **bookEvent:** multi-tier multi-quantity booking creates one booking + N lines
  with correct snapshots and total; per-tier capacity enforced; concurrent
  buyers race (double-count guard under `FOR UPDATE`); sold-out tier →
  `tier_sold_out`; mixed free+paid cart with ₹0 total skips Razorpay.

## Units / boundaries

- `event_ticket_tiers` — owns tier definition + per-event ordering. Read by
  partner forms, consumer event page, pricing, capacity check.
- `event_booking_tickets` — the booking↔tier line ledger; sole source of
  per-tier sold counts.
- `priceItem()` / `computeCheckout()` — money math; unchanged contract beyond
  summing tier lines. Still the single source of truth shared by quote + book.
- `bookEvent()` — transactional capacity + booking + redemption.
- Consumer tier selector — pure UI state (per-event cart) feeding the checkout
  modal; no persistence.
