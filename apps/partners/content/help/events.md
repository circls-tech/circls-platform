Events are one-off or recurring happenings — tournaments, classes, socials, screenings — that consumers can discover and register for. This guide covers creating an event (including weekly recurring events), defining ticket tiers, adding photos, submitting it for review, and managing registrations.

## Creating an event

1. Go to **Events** in the sidebar and click **Create event**.
2. Choose **where** the event happens:
   - **At a venue** — pick one of your venues. The event uses that venue's timezone.
   - **No venue — enter address** — supply the address fields (line 1 and 2, city, state, PIN), latitude/longitude and timezone manually.
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
| **Price (₹)** | Yes | Enter `0` for a free tier. |
| **Capacity** | No | Leave blank for unlimited. When set, the tier stops selling once that many tickets are sold. |
| **QR passes for this tier** | No | **Event default** follows the event-level QR ticket settings; **Custom** gives this tier its own pass rules; **Off** issues no passes for this tier. See **Per-tier QR rules** below. |

You can add as many tiers as you need. At least one tier is required before you can submit the event for review.

### Tiers are frozen once submitted

Ticket tiers can only be added or edited while the event is a **draft**. Once you submit the event for review, tiers are locked alongside the rest of the event details.

### What consumers see

Consumers see all tiers for an event and can buy multiple tickets across different tiers in a single checkout.

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
| **published** | Approved and live — visible to consumers, who can register. |
| **cancelled** | Cancelled by you or by circls. Read-only. |
| **rejected** | Not approved. Read-only. |

## Editing and submitting

Open an event to see its detail page. What you can do depends on its status:

- **Draft** — click **Edit** to change any field (name, description, start/end). You can also add, edit, or remove ticket tiers. When it's ready, click **Submit for review** to send it to circls, or **Cancel** to drop it.
- **Pending review** or **published** — the event and its ticket tiers are locked for editing. You can **Cancel event** at any time; cancelling a published event takes it down for consumers.
- **Cancelled** or **rejected** — read-only.

The lifecycle is: *draft → submit for review → published* (or *rejected*), with *cancel* available along the way.

## Adding event photos

You can add photos in two places:

- **On the create form** — pick up to 12 photos before clicking **Create event**; they upload automatically once the event exists.
- **On the event detail page** — use the **Photos** section to add, reorder-by-re-upload, or delete photos at any time.

JPEG, PNG or WebP, up to 10 MB each; the first photo is the cover. Photos appear to consumers in the listing, so a strong lead image helps registrations. For recurring events the whole series shares one gallery.

## Managing registrations

The event detail page shows registrations in two separate tables:

- **Registered** — everyone with an active registration (pending, confirmed, completed or no-show), with their name, email, phone number, status, amount paid (₹) and when they registered. Sold counts are shown **per tier** (e.g. "VIP — 12 sold / 50"), so you can track take-up across ticket categories at a glance.
- **Cancelled** — everyone whose registration was cancelled, with the same name, email and phone details.

Each table has its own **Download CSV** button, so you can export either list — for example to email attendees, run check-in from a spreadsheet, or follow up with people who cancelled. Email and phone come from the customer's circls account; for registrations without a linked account, whatever contact was captured at booking time is shown.

Use these tables to check turnout and reconcile payments.

## Where to find your events

- **Events** (top-level) shows every event across your whole organisation.
- A venue's **Events** page shows just that venue's events, with quick access to submit, publish-status and cancel actions.
