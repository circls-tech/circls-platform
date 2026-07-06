# QR tickets and door check-in

QR tickets let you verify entry at the door. When enabled on an event, an arena
or a membership plan, every finalised purchase automatically issues scannable QR
passes to the buyer, and your staff validate them on the **Check-in** page —
each scan is checked live against the booking, so a ticket can't be reused,
forwarded or used outside its window.

## Enabling QR tickets

You'll find an **Enable QR tickets** section on:

- the **event** create/edit form (draft events only, like other event fields) —
  one QR is issued per seat, so a booking for 3 tickets gets 3 individual passes,
  each labelled with its tier (e.g. "VIP · 2 of 3");
- the **arena** create form, and later under the arena's reception page — one QR
  is issued per booking on that arena, valid across the booked slots;
- the **membership plan** form (editable while the plan is in review or
  inactive) — each buyer gets one membership pass valid for their whole
  membership period.

For each of these you choose the rules:

| Setting | Meaning |
| --- | --- |
| **Single-use / Multi-use** | Single-use passes are spent by their first successful scan (right for event entry). Multi-use passes can be scanned repeatedly (right for memberships and multi-visit access). |
| **Max scans** | Optional cap for multi-use passes. Leave blank for unlimited. |
| **Valid from** | Minutes before the item's start time at which the pass starts working. Leave blank to make it valid immediately after purchase. |
| **Valid until** | Minutes after the item's end time at which the pass expires. Leave blank to expire exactly at the end. |

The rules are frozen onto each pass when it is issued — editing the
configuration later only affects future purchases, never tickets that customers
already hold.

Passes are issued when the purchase is finalised: immediately for free
purchases, and on payment confirmation for paid ones. If a booking is
cancelled, its passes are revoked automatically.

## Checking guests in

Open **Check-in** in the portal navigation. There are two ways to validate:

1. **Scan with any camera** — the customer's QR encodes a check-in link, so
   scanning it with a phone camera opens the Check-in page with the code
   pre-filled (you must be signed in to the portal).
2. **Type the code** — every pass shows a short code under the QR; enter it
   manually if scanning isn't possible.

The result screen tells your staff exactly what to do:

- **Valid** — let them in. The scan is counted; a single-use pass becomes
  *used* from now on.
- **Already used** — the pass was spent earlier (the first scan time is shown),
  or a capped multi-use pass has no scans left.
- **Not yet valid / Expired** — outside the validity window you configured.
- **Revoked** — the underlying booking was cancelled.
- **Not found** — not a pass for your organisation.

Use **Peek** to look a pass up *without* spending a scan — handy for support
questions ("how many scans do I have left?") or checking a pass before doors
open.

Every consumed scan is recorded in your organisation's audit log with the staff
member who scanned it.

## Where customers see their passes

Buyers find their QR passes on the booking's detail page in the Circls consumer
app (and on their membership card for membership passes) as soon as the
purchase is confirmed, together with the validity window and remaining scans.
