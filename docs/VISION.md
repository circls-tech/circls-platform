# Circls — Vision

## Target

Circls is a sports + community venue platform for India, deliberately focused on tier-2/3 cities (starting Nagpur). It is **two products on one backbone**:

1. A **SaaS toolkit for venues** — inventory, booking interface, dashboards, ticketing, check-in/verification, flexible pricing.
2. A **consumer booking platform** (`circls.app`) — first-party consumer surface; direct competitor to Playo / Khelomore.

Long-term ambition: feature, UX, and discoverability parity with Playo, differentiated by tier-2/3 depth and by the SaaS side serving venues across multiple channels.

## Business and system structure

**Circls is the inventory source of truth** for the venues that use it. Channels read and write availability through Circls's API; **money flow is channel-specific and routes around Circls**. Circls never holds consumer funds, which keeps it outside RBI Payment Aggregator licensing while still acting as the operational + commercial spine for the venue.

## Channels of service

| Channel | Path | Money flow | Refunds |
|---|---|---|---|
| **A — circls.app** (first-party consumer) | Consumer → Razorpay → split | Razorpay Route: split at settlement between the venue's Linked Account and Circls's commission account. Circls's account never holds the consumer's money. | Settlement hold until `(slot_start + cancellation_window + buffer)`; cancellation in-window reverses cleanly because the money has not yet moved. |
| **B — third-party aggregator** (Playo, Khelomore, …) | Consumer → aggregator's PSP → aggregator → venue | Circls not in the payment path; aggregator settles to venue per its existing merchant agreement; Circls earns from the venue (SaaS), not the consumer. | Handled by aggregator; Circls receives a webhook and frees the slot. |
| **C1 — venue's own site** (Circls PSP) | Same as A | Razorpay Route split; commission may be lower since the venue brought the traffic. | Settlement hold (same as A). |
| **C2 — venue's own site** (venue's PSP) | Consumer → venue's own PSP → venue | Circls only records the booking (`paymentMethod: external`). | Handled by venue. |
| **D — walk-in / phone / cash** | Customer → venue staff at counter | None through Circls. | Handled by venue. |

## Payouts

Circls **does not move money** in any channel. The Partner Portal exposes a unified payout view that joins Razorpay settlement records (A, C1), aggregator webhook data (B), and venue-recorded payments (C2, D).

## Self-serve onboarding

Sign-up → facility/resource config → walk-in dashboard target: **≤10 minutes**. Going live for online consumer payments is **gated by Razorpay Linked Account KYC** (24–72h, outside Circls's control). Until KYC clears, the venue operates in "manual bookings only" mode.

## Products / portals / units

| # | Product | Audience | Purpose |
|---|---|---|---|
| 1 | **Core Platform** (API + DB + workers + webhook engine) | internal — backs every other product | Inventory source of truth, booking state machine, payment routing, webhook in/out, notifications, authentication |
| 2 | **Partner Portal** (`partners.circls.app`) | Venue owners + staff | Self-serve onboarding, KYC, facility / resource / pricing config, live bookings dashboard, walk-in booking, QR check-in, payouts view, subscription management |
| 3 | **Consumer App** (`circls.app`) | End consumers | Discover and filter venues, book slots, memberships / passes, booking history, QR for entry |
| 4 | **Admin Console** (`admin.circls.app`) | Circls internal team | Tenant approval / suspension, KYC overrides, financial reconciliation, dispute resolution, support tooling |
| 5 | **Integration Surface** (public API + embeddable widget + SDKs) | Aggregators (Playo, Khelomore …) + venue developers | Third-party booking, inventory sync, embeddable checkout for venue-owned websites |

## Dependency tree

```
1. Core Platform         — depends on: (nothing; foundation)
2. Partner Portal        — depends on: 1
3. Consumer App          — depends on: 1; operationally on 2 (venues must be onboarded to be bookable)
4. Admin Console         — depends on: 1
5. Integration Surface   — depends on: 1; usefulness depends on a willing aggregator (B) or venue (C1/C2)
```

## Criticality

| Product | Criticality | Note |
|---|---|---|
| 1. Core Platform | **P0** | Foundation. Nothing else exists without it. |
| 2. Partner Portal | **P0** | Without self-serve onboarding + dashboard, no venue can use Circls. |
| 4. Admin Console | **P0 (minimal v0 acceptable)** | KYC approval + dispute handling are non-negotiable. v0 can be very scrappy — direct DB access acceptable for the first venues. |
| 3. Consumer App | **P1** | Required for the booking-platform half of Circls. Can be deferred while the first wave of venues onboards via the Partner Portal. |
| 5. Integration Surface | **P1** | Public API exists as soon as Core does. Aggregator integration and embeddable widget are gated on a willing partner / venue asking for them. |

## Not decided here

- **Revenue model.** Subscription / per-booking commission / hybrid is open. The schema must support channel-specific commission rules from day one regardless.
- **Timeline / staging** — addressed per product as each is designed.

Tech stack and repository structure were decided 2026-05-18 and live in [`ARCHITECTURE.md`](ARCHITECTURE.md).
