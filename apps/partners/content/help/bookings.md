This guide covers viewing bookings, exporting them, and handling cancellations, refunds and no-shows.

## Viewing bookings

1. Open a venue from **Venues**, then click **View bookings**.
2. Use the filters to narrow the list:
   - **Date range** — Today, Upcoming, Past, or a custom range.
   - **Arena** — filter to a single arena.
   - **Status** — All, Pending, Confirmed, Cancelled, Completed or No show.
   - **Search** — by customer name or contact.

The table shows the customer, contact, arena, date/time, number of slots, total and status. Totals are in the **venue's currency** (₹ for venues in India, $ for venues in the USA — set by the venue's Country). Click any row to open the **booking detail**.

A customer can book slots across several of your courts in one go (a single booking that spans multiple courts). These appear with **Multiple courts** in the arena column, count toward each court when you filter by **Arena**, and list every slot's court in the booking detail.

## Booking statuses

| Status | Meaning |
| --- | --- |
| **pending** | Created but not yet confirmed (for example, awaiting payment). |
| **confirmed** | Active and paid (or held for a reception/cash booking). |
| **completed** | The session has finished. |
| **no_show** | The customer did not turn up. |
| **cancelled** | Cancelled by the customer or by you. |

A booking paid online stays **pending** while the customer completes payment — a failed card attempt doesn't cancel it, since the customer can retry right away. If payment isn't completed within about 15 minutes, the booking is cancelled automatically and its slots are released. One online booking can cover up to 20 slots (mixing courts is fine), and a customer can hold at most 20 slots across unpaid bookings at a time — further checkouts are refused until those are paid or have expired. In the rare case a payment completes after the booking was already cancelled, the customer is refunded in full automatically.

In India, if the payment page doesn't work for a customer (or the gateway is having trouble), their checkout can move from Cashfree to Razorpay. The booking's payments ledger then shows the abandoned attempt as **failed**, next to the payment that went through. If a customer ends up paying twice for the same booking, the extra payment is refunded to them automatically and never counts toward your payout.

## The booking detail

The detail view shows the customer's information, the arena (or **Multiple courts** for a cross-court booking), status, total, the booking channel and payment method, the list of **slots** with their times and prices — each labelled with its court when the booking spans more than one — and a **payments ledger** (charges, refunds and adjustments with their status and amounts). If the booking isn't already cancelled, Owners, Managers and Staff see a **Refund booking** action; Read-only members can view the booking but not cancel or refund it.

### Payment methods

- **external** — paid offline at the venue (cash/card on site). No online refund is processed.
- **razorpay_route** — paid online through the venue's payment gateway: **Razorpay** or **Cashfree** for venues in India (₹), **Stripe** for venues in the USA ($). The gateway follows the venue's country, set on the venue's address. The customer's total includes an "Other charges (incl taxes)" line covering the gateway's processing charge (and any Circls platform fee configured for your organisation); your Partner Agreement sets whether your organisation bears a share of the processing charge, which is deducted from your weekly payout. Refunds are processed back to the customer through the same gateway that took the payment.
- **free** — a free booking; nothing to refund.

## QR entry passes for arena bookings

If an arena has **QR tickets** enabled (on the arena's create form, or later
from its reception page), every confirmed booking on it issues the customer a
scannable entry pass covering their booked slots. Validate passes on the
portal's **Check-in** page; cancelling a booking revokes its passes
automatically. See [QR tickets and door check-in](/help/qr-tickets).

## Refunding a booking

Refunding a booking also cancels it and releases its slots — the two go together, which is why there is a single action for both. Owners, Managers and Staff can do it; Read-only members can't.

1. From the booking detail, click **Refund booking**.
2. The refund page summarises the booking and shows a **refund preview**: what the customer gets back if you refund now, worked out with the same rules as the refund itself:

   | Booking | Refund |
   | --- | --- |
   | Paid online | **Full refund**, however close the slot (or event) is — shown as *Full refund (override)*. If part of the payment was already refunded, the rest of it. |
   | Paid online, already refunded in full | Nothing more to refund — the booking is just cancelled |
   | Payment never completed | Nothing to refund — the customer was never charged |
   | Paid at the venue (external) | No online refund — settle it at the counter |
   | Free booking | Nothing to refund |

3. Enter a **reason for the refund** (required).
4. Click **Refund booking**.

A refund issued by you or your team is always in full, however close to the start: it's a discretionary, out-of-policy refund, recorded as such in the audit log. The one exception is a booking you made yourself, from your own customer account — that follows the customer cancellation tiers (full refund more than 24 hours before the start, 50% between 2 and 24 hours, nothing inside 2 hours), and the preview shows which applies.

The **final refund amount is decided by the server at the moment you submit**, so it can differ from the preview if the booking changes while the page is open — for example, the customer completes a payment that was still pending. On success you'll see the refund that was applied, the final refund amount, and a refund ID if one was issued. The refund and its reason are logged.

Cancelling a booking from an arena's reception grid is the same cancellation without the reason: it frees the slot and, for a booking paid online, refunds the customer in full. The confirmation shows what will be refunded before you confirm.

## No-shows

When a customer doesn't turn up, their booking can be marked **no_show**. This keeps your records and analytics accurate and distinguishes genuine no-shows from cancellations. No-show handling does not by itself trigger a refund.

## Exporting bookings

Click **Download CSV** above the bookings list to export the currently filtered bookings. The file includes the booking ID, customer, contact, arena, start/end times, slot count, total, status, channel and the time it was booked — handy for reconciliation and reporting.
