This guide covers viewing bookings, exporting them, and handling cancellations, refunds and no-shows.

## Viewing bookings

1. Open a venue from **Venues**, then click **View bookings**.
2. Use the filters to narrow the list:
   - **Date range** — Today, Upcoming, Past, or a custom range.
   - **Arena** — filter to a single arena.
   - **Status** — All, Pending, Confirmed, Cancelled, Completed or No show.
   - **Search** — by customer name or contact.

The table shows the customer, contact, arena, date/time, number of slots, total (₹) and status. Click any row to open the **booking detail**.

## Booking statuses

| Status | Meaning |
| --- | --- |
| **pending** | Created but not yet confirmed (for example, awaiting payment). |
| **confirmed** | Active and paid (or held for a reception/cash booking). |
| **completed** | The session has finished. |
| **no_show** | The customer did not turn up. |
| **cancelled** | Cancelled by the customer or by you. |

## The booking detail

The detail view shows the customer's information, the arena, status, total, the booking channel and payment method, the list of **slots** with their times and prices, and a **payments ledger** (charges, refunds and adjustments with their status and amounts). If the booking isn't already cancelled, you'll see a **Cancel booking** action.

### Payment methods

- **external** — paid offline at the venue (cash/card on site). No online refund is processed.
- **razorpay_route** — paid online. Refunds are processed back to the customer.
- **free** — a free booking; nothing to refund.

## Cancelling a booking and refunds

1. From the booking detail, click **Cancel booking**.
2. The cancellation page summarises the booking and shows a **refund preview**. The preview is a guide based on how far ahead of the slot you're cancelling:

   | Timing / type | Indicative refund |
   | --- | --- |
   | More than 24 hours before start | Full refund |
   | 2–24 hours before start | 50% refund |
   | Less than 2 hours before start | No refund |
   | Paid at the venue (external) | No online refund |
   | Free booking | Nothing to refund |

3. Enter a **cancellation reason** (required).
4. Click **Cancel booking**.

The **final refund amount is decided by the server at the moment of cancellation**, so it can differ slightly from the preview. On success you'll see the refund policy that was applied, the final refund amount, and a refund ID if one was issued. The cancellation and its reason are logged.

## No-shows

When a customer doesn't turn up, their booking can be marked **no_show**. This keeps your records and analytics accurate and distinguishes genuine no-shows from cancellations. No-show handling does not by itself trigger a refund.

## Exporting bookings

Click **Download CSV** above the bookings list to export the currently filtered bookings. The file includes the booking ID, customer, contact, arena, start/end times, slot count, total, status, channel and the time it was booked — handy for reconciliation and reporting.
