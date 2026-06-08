# Coupon Codes + Transparent Checkout — Design

**Date:** 2026-06-08
**Status:** Approved (pending spec review)

## Summary

Add two intertwined capabilities to the Circls platform:

1. **Transparent checkout** — every "Book / Register / Buy" action opens a checkout
   modal that itemises the base price, an "Other charges (incl taxes)" line that grosses
   up the base to cover the Razorpay payment-gateway fee, and the final total. This is a
   **universal** change: the gross-up applies to every booking, with or without a coupon.

2. **Discount coupon codes** — codes that reduce the base ticket price. Codes can be
   created Circls-wide in the admin console (platform-funded) or by an org in the partners
   portal (org-funded), scoped to the whole org, a venue, or one specific event / arena /
   membership. A code is either a percentage or a fixed-paise discount, with optional caps,
   validity window, and redemption limits. Public codes are listable at checkout; private
   codes must be typed.

Surfaces in scope: backend API (`apps/api`), admin console (`apps/admin`), partners portal
(`apps/partners`), web consumer (`apps/consumer`), and the Flutter consumer app
(separate repo at `/Users/vedant/personal/circls`).

## The money model

Let `r = 0.0236` — the Razorpay fee including GST on that fee. This is the only add-on;
there is no separate ticket GST.

### Without a coupon

```
base         = sum of item prices (slots / event / membership)   ← unchanged; org revenue
total        = ceil( base / (1 − r) )                            ← what the customer pays
otherCharges = total − base                                      ← the "Other charges (incl taxes)" line
```

This is **self-balancing**: the customer pays `total`, Razorpay deducts `r × total`, and
Circls nets exactly `base`. All existing payout/commission math (which works off `base`)
is therefore unaffected.

### With a coupon

Discount applies to the base; the gross-up is computed on the reduced base.

```
discount       = percent or fixed; for percent, capped by max_discount_paise; floored at 0
discountedBase = max(0, base − discount)
total          = ceil( discountedBase / (1 − r) )
otherCharges   = total − discountedBase
```

If `discountedBase == 0` (100% / fixed ≥ base), the booking is **free** — skip Razorpay
entirely and confirm directly, mirroring the existing free-item path.

### Rounding

`total` uses `ceil` so Circls never under-nets the (discounted) base after the gateway
deduction. Amounts are integer paise throughout.

### Who funds the discount (payout impact only)

- **Org-funded** (org / venue / item coupons): the org simply nets `discountedBase`. No
  change to payout logic.
- **Platform-funded** (admin Circls-wide coupons): the org must still net the full `base`.
  The weekly payout job adds the redemption's `discount_paise` back to that tenant's gross
  and books it against Circls' margin.

Each redemption records `funder = 'org' | 'platform'` so this is computable after the fact.

### Worked examples (r = 0.0236)

| Scenario | base | discount | discountedBase | total | otherCharges |
|---|---|---|---|---|---|
| No coupon, ₹500 | 50000 | — | 50000 | 51209 | 1209 |
| 10% coupon, ₹500 | 50000 | 5000 | 45000 | 46088 | 1088 |
| ₹50 fixed, ₹500 | 50000 | 5000 | 45000 | 46088 | 1088 |
| 100% coupon | 50000 | 50000 | 0 | 0 (free) | 0 |

(All values in paise.)

## Data model

New migration `apps/api/src/db/migrations/0022_coupons.sql` (hand-written, post-0009
convention with `--> statement-breakpoint`). New schema files
`apps/api/src/db/schema/coupons.ts` and `coupon_redemptions.ts`.

### `coupons`

| column | type | notes |
|---|---|---|
| `id` | uuid PK (uuidv7) | |
| `owner_type` | enum `'platform' \| 'tenant'` | who created it |
| `tenant_id` | uuid, nullable | set for org-owned; null for platform |
| `code` | text | unique per owner — see partial-index note below |
| `description` | text, nullable | |
| `scope_type` | enum `'org' \| 'venue' \| 'event' \| 'arena' \| 'membership'` | |
| `scope_id` | uuid, nullable | venue/event/arena/membership id; null for org-wide & platform-wide |
| `discount_type` | enum `'percent' \| 'fixed'` | |
| `discount_value` | bigint | bps when percent, paise when fixed |
| `max_discount_paise` | bigint, nullable | cap for percent coupons |
| `min_order_paise` | bigint, nullable | minimum base to qualify |
| `visibility` | enum `'public' \| 'private'` | public = listable at checkout |
| `valid_from` | timestamptz, nullable | |
| `valid_until` | timestamptz, nullable | |
| `max_redemptions` | integer, nullable | total cap across all users |
| `per_user_limit` | integer, nullable | redemptions allowed per user |
| `redeemed_count` | integer, default 0 | atomic increment |
| `status` | enum `'active' \| 'paused' \| 'expired'` | default `'active'` |
| `created_at` / `updated_at` | timestamptz | |

Code uniqueness is enforced with **two partial unique indexes** (because platform rows have
`tenant_id IS NULL`, and Postgres treats NULLs as distinct, a plain composite unique would
not constrain platform codes):

- `UNIQUE (code) WHERE owner_type = 'platform'` — platform codes share one namespace.
- `UNIQUE (tenant_id, code) WHERE owner_type = 'tenant'` — org codes are unique per tenant.

Other indexes: `(tenant_id)`, `(owner_type)`, `(scope_type, scope_id)`.

### `coupon_redemptions`

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `coupon_id` | uuid FK → coupons | |
| `booking_id` | uuid FK → bookings | |
| `user_id` | uuid | the consumer |
| `tenant_id` | uuid | the org whose item was bought (for payout add-back) |
| `base_paise` | bigint | base before discount |
| `discount_paise` | bigint | applied discount |
| `funder` | enum `'org' \| 'platform'` | who absorbs the discount |
| `created_at` | timestamptz | |

Constraints: `UNIQUE(coupon_id, booking_id)`. Index `(coupon_id, user_id)` for per-user
counting; index `(tenant_id, funder, created_at)` for the payout job.

### `bookings` additions

Add nullable `coupon_id` (FK → coupons), `discount_paise` (bigint, default 0). The
existing `total_paise` stores the grossed-up amount actually charged. The org's payout
base remains the item `base` (= `total_paise`'s pre-gross-up figure derived as
`base = price subtotal`, **not** `total_paise`). To avoid recomputation, also persist
`base_paise` on the booking (sum of item prices before discount/gross-up).

## API (apps/api, Fastify, `/v1`)

### Shared calculation module

A single pure function `computeCheckout({ basePaise, coupon? }) -> { basePaise,
discountPaise, discountedBasePaise, otherChargesPaise, totalPaise }` in a new
`apps/api/src/services/checkout_pricing.ts`, used by **both** the quote endpoint and the
authoritative booking path so the numbers can never diverge. `r` is a named constant
(`RAZORPAY_FEE_RATE = 0.0236`).

### Consumer endpoints

- `POST /v1/consumer/checkout/quote` — body `{ itemType, itemRefs, couponCode? }`; returns
  `{ basePaise, discountPaise, discountedBasePaise, otherChargesPaise, totalPaise, coupon?,
  error? }`. Pure calculation, **no side effects**. Drives live UI feedback in the modal.
- `GET /v1/consumer/coupons?itemType=&itemId=` — public, in-window, applicable coupons for
  that item (platform public coupons + the item's tenant's public coupons matching scope),
  for the "View available offers" picker.
- Booking creation — extend the existing
  `POST /v1/consumer/bookings`, `POST /v1/consumer/events/:id/book`,
  `POST /v1/consumer/memberships/:id/purchase` to accept optional `couponCode`. The server
  **re-validates authoritatively** (never trusts the client quote), runs `computeCheckout`,
  creates the Razorpay order for `totalPaise`, and inside the same transaction inserts the
  `coupon_redemptions` row and atomically bumps `redeemed_count` with total/per-user limit
  checks. On a free `discountedBase == 0`, skip Razorpay and confirm directly.

### Code resolution at checkout

Given a typed code and the item being purchased, look up the code among **platform
coupons + the item's tenant coupons**. On an exact-code collision, the **org-owned coupon
wins**. Then validate: scope matches the item, status is `active`, now is within the
window, `base >= min_order_paise`, and total/per-user limits not exceeded.

### Management endpoints

- Org (partners): `GET/POST /v1/tenants/:tenantId/coupons`,
  `PATCH/DELETE /v1/tenants/:tenantId/coupons/:id`.
- Admin (platform): `GET/POST /v1/admin/coupons`,
  `PATCH/DELETE /v1/admin/coupons/:id`.

New capabilities in `apps/api/src/lib/authz/capabilities.ts` + `role_caps.ts`:

- Partner: `discounts.read`, `discounts.write` — owner & manager get write; staff get read;
  readonly gets read.
- Platform: `admin.coupons.write` (and reuse `admin.coupons.read` / existing read pattern)
  for Circls-wide coupons.

All mutations write `audit_log` via `writeAudit(tx, ctx, 'coupon.created' | 'coupon.updated'
| 'coupon.deleted', 'coupon', id, old, new)`.

### Payout job change

The weekly settlement job is extended: for each `coupon_redemptions` row in the period with
`funder = 'platform'`, add `discount_paise` back to that tenant's gross (so the org nets the
full base) and deduct it from Circls' margin. `funder = 'org'` rows need no adjustment.

## Consumer checkout modal

Every "Book / Register / Buy" entry point opens a checkout modal instead of going straight
to Razorpay.

```
┌─ Checkout ───────────────────────────┐
│  Friday 6–7 PM · Court 1              │
│                                       │
│  Base price                  ₹500.00  │
│  Coupon  [ SUMMER10      ] [Apply]    │
│   ▸ View available offers             │
│  Discount (SUMMER10)        −₹50.00   │
│  Other charges (incl taxes)  ₹11.07   │
│  ─────────────────────────────────    │
│  Total                      ₹461.07   │
│                                       │
│  [        Pay ₹461.07         ]       │
└───────────────────────────────────────┘
```

- "View available offers" expands a picker populated from
  `GET /v1/consumer/coupons`; one tap applies a public code. Private codes are typed into
  the field and validated via the quote endpoint.
- The modal calls `POST /v1/consumer/checkout/quote` whenever the coupon changes and
  re-renders the line items, then on "Pay" calls the booking endpoint (which returns the
  Razorpay order) and opens Razorpay — or confirms directly when the total is free.

### Web (`apps/consumer`, Next.js)

New reusable `<CheckoutModal>` component wired into the venue arena/event/membership cards
and the event/membership detail pages, replacing the current direct
`bookSlotsNow / bookEventNow / buyMembershipNow` calls in `useCheckout`. The hook is
extended to drive the modal lifecycle and pass `couponCode` through.

### Flutter (`/Users/vedant/personal/circls`)

The existing `ReviewScreen`
(`lib/src/presentation/booking/review_screen.dart`) becomes this modal: add a coupon
text field + an "available offers" bottom sheet, render the new line items (base, discount,
other charges, total), call the quote endpoint via a new repository method, and thread
`couponCode` into the existing booking repositories
(`booking_api_repository.dart` and the event/membership equivalents). New Freezed models for
the quote response and applicable-coupon list.

## Partners & Admin UI

### Partners portal (`apps/partners`)

New **top-level "Coupons"** nav item → list + create/edit form, mirroring the existing
events/memberships CRUD patterns (`lib/api/coupons.ts` hooks; `app/(protected)/coupons/`
pages). Form fields: code, description, scope picker (org-wide / choose venue / choose a
specific event, arena, or membership), discount type & value, max-discount cap (percent
only), min order, visibility, validity window, total & per-user limits, status. Gated by
`discounts.read` / `discounts.write`.

### Admin console (`apps/admin`)

New **Coupons** page to create and manage platform-wide (Circls-funded) coupons — same
form minus tenant/org scoping (platform coupons are either platform-wide or, optionally,
targeted at a specific tenant's item by id). Gated by `admin.coupons.write`.

## Help Centre (required by repo CLAUDE.md)

In the same PR:

- New article `apps/partners/content/help/coupons.md` (how orgs create and scope coupons,
  public vs private, redemption limits, who funds platform coupons) + matching metadata
  entry in `apps/partners/lib/help/articles.ts`.
- Update the checkout/pricing help content to explain the new "Other charges (incl taxes)"
  line, and update `apps/partners/content/help/README.md`'s article → code-area map.

## Error handling

- Quote/booking coupon errors return a typed code + message:
  `coupon_not_found`, `coupon_expired`, `coupon_not_started`, `coupon_inactive`,
  `coupon_scope_mismatch`, `coupon_min_order`, `coupon_max_redeemed`,
  `coupon_user_limit`. The modal shows a friendly inline message and leaves the base
  pricing intact (coupon simply not applied).
- Redemption insert + `redeemed_count` bump happen in the booking transaction; a limit
  race that loses rolls the whole booking back with `coupon_max_redeemed`.
- Authoritative recompute on the server guards against a stale or tampered client quote;
  if the recomputed total differs from what the client showed, the server's number wins and
  the Razorpay order is created for the server total.

## Testing

- **Unit**: `computeCheckout` — gross-up rounding (ceil), percent vs fixed, cap, floor at 0,
  free-when-zero, min-order gate.
- **Unit**: code resolution & validation — scope match, window, status, limits,
  org-beats-platform collision.
- **Integration (api)**: quote endpoint; booking with org coupon (redemption row + count
  bump + payout base unchanged); booking with platform coupon (funder=platform, payout
  add-back); free-after-coupon path; per-user & total limit enforcement under concurrency.
- **Integration**: payout job add-back for platform-funded redemptions.
- **Web/Flutter**: modal renders correct line items from a quote; applying a public offer;
  invalid code inline error; free total skips Razorpay.

## Out of scope (YAGNI)

- Coupon stacking (one coupon per checkout).
- Auto-apply / no-code promotions.
- Scheduled ramps or A/B coupon experiments.
- Category/BOGO/bundle logic.
- Refund handling of the gross-up beyond existing refund flows.

## Implementation phasing (for the plan)

1. Backend: schema + migration, `computeCheckout`, coupon CRUD + capabilities, code
   resolution/validation, quote endpoint, public-coupon list.
2. Backend: booking integration (redemption + limits + free path) and payout add-back.
3. Partners portal Coupons UI; Admin console Coupons UI.
4. Web consumer checkout modal + gross-up.
5. Flutter consumer checkout modal + gross-up.
6. Help Centre article + pricing note (same PR).
