Coupons are discount codes your customers apply at checkout to reduce the price of an event, membership, or court booking. The discount comes off your base price; Razorpay's payment-processing charge is added on top of the reduced price (shown to the customer as "Other charges (incl taxes)").

## Creating a coupon

Go to **Coupons** in the sidebar and click **Create coupon**, then set:

- **Code** — e.g. `SUMMER10`. Stored in uppercase and must be unique within your organisation. Customers type this at checkout (or tap it from the offers shown there if it's public).
- **Scope** — where the coupon applies:
  - **Whole organisation** — any of your events, memberships and bookings.
  - **A venue** — anything at that venue.
  - **A specific event / arena / membership** — only that item.
- **Discount type** — **Percentage** (e.g. 10% off, with an optional maximum-discount cap) or **Fixed** (e.g. ₹50 or $5 off). Money fields are in the currency of the coupon's scope — the field labels show ₹ or $ to match (a coupon scoped to a US venue is in dollars; org-wide coupons follow your organisation's country).
- **Minimum order** — optional; the base price must be at least this for the code to apply.
- **Visibility** — **Private** (the customer must know and type the code) or **Public** (applicable codes are shown as tappable offers under the coupon field at checkout — for event tickets, court bookings, and memberships alike — and tapping one applies it).
- **Valid from / until** — optional window; outside it the code won't apply.
- **Total max redemptions** and **Per-user limit** — optional caps on how many times the code can be used overall and by a single customer.

A new coupon is **active** immediately (subject to its validity window).

## How the discount is applied

The discount reduces your **base price**. The customer then pays that reduced base plus the payment-gateway charge. Only one coupon can be used per checkout.

## Statuses

| Status | Meaning |
| --- | --- |
| **active** | Live — usable within its validity window and limits. |
| **paused** | You've paused it; customers can't use it until you resume. |
| **expired** | Past its valid-until date. |

## Editing, pausing, deleting

Open a coupon to see its usage (e.g. `5/100` redeemed). You can edit its description, visibility, minimum order, max-discount cap, validity window, and redemption limits, and **Pause**/**Resume** or **Delete** it. The **code, scope, and discount amount cannot be changed** after creation — create a new coupon if you need different ones.

## Who pays for the discount

Coupons you create reduce your own revenue for that sale. Circls-wide promotional codes (created by the Circls team) are funded by Circls — your payout is unaffected by those.
