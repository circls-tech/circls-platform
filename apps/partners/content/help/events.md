Events are one-off or recurring happenings — tournaments, classes, socials, screenings — that consumers can discover and register for. This guide covers creating an event (including weekly recurring events), defining ticket tiers, adding registration questions, adding photos, submitting it for review, and managing registrations.

## Creating an event

1. Go to **Events** in the sidebar and click **Create event**.
2. Choose **where** the event happens:
   - **At a venue** — pick one of your venues. The event uses that venue's timezone.
   - **No venue — enter address** — start typing in **Search address** and pick a suggestion to fill the street, city, state, PIN and country automatically (results are limited to the regions circls serves), or fill the fields by hand. **Country** is chosen from a dropdown (currently India or the USA) and also sets the currency tickets sell in. Below the address fields, a **map** shows where the event will appear to customers: it centres on the city you've typed, and you can **click the map (or drag the pin) to mark the exact spot** — recommended, since customers browsing nearby events see exactly this point. If you don't place a pin, the map location is derived from the typed address when the event is created. There's never a need to enter latitude/longitude by hand. City names you type by hand are tidied automatically: common variants of major cities are stored under one canonical spelling ("Bangalore" or "bombay" become "Bengaluru" and "Mumbai"), and a likely typo shows a **"Did you mean …?"** hint under the City field — click it to accept. This keeps your event under the same city customers browse by. Enter the **timezone** (IANA name, e.g. `Asia/Kolkata`) yourself.
3. Fill in the details:
   - **Name** (required).
   - **Description** (optional).
   - **Starts** and **Ends** (required) — entered in the venue's timezone.
   - **Repeats** — leave on **One time**, or switch to **Repeats weekly** for a recurring event (see below).
   - **Photos** (optional) — add up to 12 photos right on the create form; they upload automatically when the event is created, and the first one becomes the cover.
4. Click **Create event**.

The event is created as a **draft** and you're returned to the Events list. Add ticket tiers next (see below) before submitting.

## Recurring events

For something that happens regularly — say a dance workshop every Thursday and Friday — switch **Repeats** to **Repeats weekly**:

1. Pick the **days of the week** it runs on.
2. Pick the **last date** (**Until**). The first date comes from the **Starts** field.
3. The form shows how many dates will be created (up to 104).

Each date becomes its own event with its own registrations, capacity, and attendee list — consumers book a specific date. On the consumer side the series appears as **one listing** with a date picker, so it doesn't flood the events feed.

### Advanced settings (per-date changes)

Open **Advanced settings** under the weekly options to fine-tune individual dates before creating:

- **Time** — a specific date can start/end at different times.
- **Venue** — a specific date can happen at a different venue (e.g. Fridays at your other branch).
- **Tickets** — a specific date can have its own ticket tiers and prices (e.g. a finale that costs more).
- **Skip** — drop a generated date (e.g. a festival day). Skipped dates can be restored until you create the event.

### Managing a series

Every date of the series shows on the event detail page under **Series dates**, with links to each one. From there (or from the Events list) you can **submit all dates for review at once** or **cancel the entire series**; the circls team likewise approves or rejects the whole series in one decision. Individual dates can still be edited (while drafts) or cancelled on their own pages.

Photos are shared across the series: upload them once (on the create form or on any date's page) and every date — and the consumer listing — uses the same gallery.

## Ticket tiers

Every event is sold through one or more **ticket tiers**. Each tier has its own name, price, and capacity, so you can offer different ticket categories (e.g. General Admission, VIP, Early Bird) in a single event.

### Defining tiers

On the event detail page (while the event is a **draft**), use the **Ticket tiers** section to add and manage tiers. For each tier:

| Field | Required? | Notes |
| --- | --- | --- |
| **Name** | Yes | Shown to consumers at checkout (e.g. "General Admission", "VIP"). |
| **Description** | No | Optional detail shown alongside the tier name. |
| **Price** | Yes | Enter `0` for a free tier. The label shows the event's currency (₹ or $): venue events use the venue's currency; standalone events follow the country in their address (or your organisation's country until one is set). |
| **Capacity** | No | Leave blank for unlimited. When set, the tier stops selling once that many tickets are sold. |
| **QR passes for this tier** | No | **Event default** follows the event-level QR ticket settings; **Custom** gives this tier its own pass rules; **Off** issues no passes for this tier. See **Per-tier QR rules** below. |

You can add as many tiers as you need. At least one tier is required before you can submit the event for review.

### Limiting tickets per customer

Tick **Limit tickets per customer** on the event form and set **Max tickets per customer** to cap how many tickets one person can hold for the event **in total, across all tiers** — and across all their bookings, not just one checkout. Set it to `1` on a free multi-slot event (where each tier is a time slot) so one person can claim a single seat, not a seat in every slot. Leave it off for no limit.

Unlike most settings, this limit stays editable **after the event goes live** (see **Live settings** below). Raising or lowering it never affects tickets people already hold — it only gates future purchases, so someone already over a newly lowered limit keeps their tickets but can't buy more.

### Tiers are frozen once submitted

Ticket tiers can only be added or edited freely while the event is a **draft**. Once you submit the event for review, tiers are locked alongside the rest of the event details. After the event is published, tier **capacity increases** stay free (see **Live settings** below), and any other tier change — names, prices, adding or removing tiers — goes through a **change request** that the circls team approves first (see **Requesting changes to a live event**).

### Live settings (editable after publish)

Once the event is **published**, its detail page shows a **Live settings** card with everything you can still change freely, without review:

- **Tier capacity — increases only.** A capped tier can go higher, or be set blank for unlimited, when demand outgrows the room you planned. It can never go *down* (and an unlimited tier can't become capped), so tickets already sold are never invalidated.
- **Max tickets per customer** — raise, lower, set, or clear it freely; it only applies to future purchases.
- **Description** — fix typos or add details any time.
- **Registration questions** — add, edit, remove, or reorder. Answers people already gave are kept under the question's old wording, so if you edit a question mid-event, the registrations CSV shows the old and new versions as **two separate columns**.
- **QR ticket rules** — event-level QR settings; changes only apply to future registrations, passes customers already hold are never changed.

The remaining fields — **name, date & time, location, and ticket tiers** — change only through an approved change request, described next.

### Requesting changes to a live event

To change a live event's **name**, **date & time**, **location** (its venue, or a standalone event's address), or **ticket tiers** (names, prices, adding or removing tiers), use the **Request changes** card on the event's detail page. Your proposal is sent to the circls team for review and applies only after they approve it — consumers keep seeing the current details until then.

How it works:

- **One request at a time.** While a request is pending you can't submit another; **withdraw** it from the banner on the event page if you want to change your proposal.
- **Approved** — the changes are applied to the live event immediately and the page notes your request was approved.
- **Declined** — the event stays as it was; the reviewer's reason (if given) is shown on the event page, and you can submit a corrected request.
- **Tier safety rules** — a tier that already has registrations can't be removed, and a tier's capacity can't be set below the number of tickets already sold. Editing a tier keeps sold tickets attached to it (renames and price changes never affect tickets people already hold — new buyers pay the new price).
- If the event is **cancelled** while a request is pending, the request can no longer be approved.

Note that tier renames also update how past registrations are displayed and exported — the registrations table shows the tier's current name.

### What consumers see

Consumers see all tiers for an event and can buy multiple tickets across different tiers in a single checkout. When the event limits tickets per customer, the page says so ("Limited to N tickets per person for this event") and the quantity selectors stop at the limit across all tiers combined; if a customer already holds tickets from an earlier booking, a new booking that would push them over the cap is rejected at checkout.

## Registration questions

Need to know something extra from every attendee — T-shirt size, dietary restrictions, an emergency contact? Add **registration questions** to the event form (while the event is a **draft**) and consumers answer them when they book.

For each question you set:

| Field | Notes |
| --- | --- |
| **Question** | What you're asking, e.g. "What is your T-shirt size?". |
| **Answer type** | **Free text** for an open answer, or **Multiple choice** to make the consumer pick one of your options. |
| **Options** | Multiple choice only — the choices, comma-separated (at least 2, e.g. "Small, Medium, Large"). |
| **Required** | Ticked = the consumer can't finish booking without answering. Unticked = answering is optional. |

Use the arrows to reorder questions; consumers see them in this order. You can add up to 20 questions, and events don't need any — leave the section empty to skip it.

Questions are editable while the event is a **draft**, locked during review, and editable again once the event is **published** (from the **Live settings** card). Editing a question mid-event keeps the answers people already gave under the old wording — in the registrations CSV, the old and new versions appear as two separate columns. Answers appear with each registration (see **Managing registrations** below).

Don't confuse these with **customer questions** — the public Q&A threads consumers post on your event page (see the end of this guide). Registration questions are asked *by you* and answered privately at booking.

## QR entry tickets

Turn on **QR tickets** on the event form (while the event is a draft) to have
every confirmed registration issue scannable entry passes — one per seat, each
labelled with its tier. You choose single- or multi-use, an optional scan cap,
and how long before the start / after the end the passes work. Staff validate
them on the portal's **Check-in** page. See [QR tickets and door
check-in](/help/qr-tickets) for the full guide.

### Per-tier QR rules

The event-level QR setting is the default for all ticket tiers, and each tier
can override it with its own **QR passes for this tier** control:

- **Event default** — passes for this tier follow the event-level settings.
- **Custom** — this tier issues passes with its own rules, ignoring the
  event-level settings. Useful when tiers grant different access — e.g. a VIP
  multi-day tier can issue a multi-use pass with a scan cap while General
  Admission stays single-entry. A tier with custom rules issues passes even
  when event-level QR tickets are off.
- **Off** — no passes for this tier, even when the event enables them.

Like the event-level rules, tier overrides only apply to future registrations —
passes customers already hold are never changed.

## Event statuses

| Status | Meaning |
| --- | --- |
| **draft** | Created but not yet submitted. Fully editable, including ticket tiers. Only you can see it. |
| **pending_review** | Submitted and awaiting the circls team's approval. |
| **published** | Approved and live — visible to consumers, who can register. Live settings stay freely editable; name/time/location/tier changes need an approved change request. |
| **cancelled** | Cancelled by you or by circls. Read-only. |
| **rejected** | Not approved. Read-only. |

## Editing and submitting

Open an event to see its detail page. What you can do depends on its status:

- **Draft** — click **Edit** to change any field (name, description, start/end). You can also add, edit, or remove ticket tiers. When it's ready, click **Submit for review** to send it to circls, or **Cancel** to drop it.
- **Pending review** — the event and its ticket tiers are locked for editing. You can still **Cancel event**.
- **Published** — the **Live settings** card stays freely editable (capacity increases, per-customer limit, description, registration questions, QR rules), and the **Request changes** card sends name/date/location/tier changes to circls for approval — see above. You can **Cancel event** at any time; cancelling a published event takes it down for consumers.
- **Cancelled** or **rejected** — read-only.

The lifecycle is: *draft → submit for review → published* (or *rejected*), with *cancel* available along the way.

## Adding event photos

You can add photos in two places:

- **On the create form** — pick up to 12 photos before clicking **Create event**; they upload automatically once the event exists.
- **On the event detail page** — use the **Photos** section to add, reorder-by-re-upload, or delete photos at any time.

JPEG, PNG or WebP, up to 10 MB each; the first photo is the cover. Photos appear to consumers in the listing, so a strong lead image helps registrations. For recurring events the whole series shares one gallery.

## Managing registrations

The event detail page shows registrations in two separate tables:

- **Registered** — everyone with an active registration (pending, confirmed, completed or no-show), with their name, email, phone number, the tickets they hold (tier and quantity, e.g. "General ×2, VIP ×1"), their answers to your **registration questions** (when the event asks any), status, amount paid (in the event's currency) and when they registered. Sold counts are shown **per tier** (e.g. "VIP — 12 sold / 50"), so you can track take-up across ticket categories at a glance.
- **Cancelled** — everyone whose registration was cancelled, with the same name, email and phone details.

Each table has its own **Download CSV** button, so you can export either list — for example to email attendees, run check-in from a spreadsheet, or follow up with people who cancelled. When the event has registration questions, the CSV gets **one extra column per question**, so answers line up ready for a spreadsheet. Email and phone come from the customer's circls account; for registrations without a linked account, whatever contact was captured at booking time is shown.

Use these tables to check turnout and reconcile payments.

### Cancelling a registration

Every row in the **Registered** table has a **Cancel** button. Cancelling on behalf of an attendee:

- refunds a paid registration **in full** to the original payment method, regardless of how close the event is (staff cancellations are out-of-policy by design and are recorded in the audit log);
- revokes the attendee's QR entry passes so they can no longer check in;
- frees the seats — tier sold counts and any per-person ticket limits no longer count the cancelled registration;
- moves the row to the **Cancelled** table.

Free registrations and payments that were never completed are simply cancelled — there is nothing to refund. Cancellation can't be undone; the attendee has to register again if plans change.

## Customer questions

Customers browsing a published event can ask **questions** on it — public ones appear on the event's consumer page as a Q&A section, private ones are visible only to the asker, your team and the circls team. Answer them from the **Questions** inbox in the sidebar; each thread links back to the event it's about. See [Answering customer questions](/help/questions).

## Where to find your events

- **Events** (top-level) shows every event across your whole organisation.
- A venue's **Events** page shows just that venue's events, with quick access to submit, publish-status and cancel actions.
