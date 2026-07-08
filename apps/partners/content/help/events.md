Events are one-off or scheduled happenings — tournaments, classes, socials, screenings — that consumers can discover and register for. This guide covers creating an event, defining ticket tiers, adding images, submitting it for review, and managing registrations.

## Creating an event

1. Go to **Events** in the sidebar and click **Create event**.
2. Choose **where** the event happens:
   - **At a venue** — pick one of your venues. The event uses that venue's timezone.
   - **No venue — enter address** — supply the address fields (line 1 and 2, city, state, PIN), latitude/longitude and timezone manually.
3. Fill in the details:
   - **Name** (required).
   - **Description** (optional).
   - **Starts** and **Ends** (required) — entered in the venue's timezone.
4. Click **Create event**.

The event is created as a **draft** and you're returned to the Events list. Add ticket tiers next (see below) before submitting.

## Ticket tiers

Every event is sold through one or more **ticket tiers**. Each tier has its own name, price, and capacity, so you can offer different ticket categories (e.g. General Admission, VIP, Early Bird) in a single event.

### Defining tiers

On the event detail page (while the event is a **draft**), use the **Ticket tiers** section to add and manage tiers. For each tier:

| Field | Required? | Notes |
| --- | --- | --- |
| **Name** | Yes | Shown to consumers at checkout (e.g. "General Admission", "VIP"). |
| **Description** | No | Optional detail shown alongside the tier name. |
| **Price** | Yes | Enter `0` for a free tier. The label shows the event's currency (₹ or $): venue events use the venue's currency; standalone events your organisation's — both follow the country on file. |
| **Capacity** | No | Leave blank for unlimited. When set, the tier stops selling once that many tickets are sold. |

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

## Adding event images

On the event detail page, use the **images** section to upload photos for the event. These appear to consumers in the listing, so a strong lead image helps registrations.

## Managing registrations

The event detail page shows registrations in two separate tables:

- **Registered** — everyone with an active registration (pending, confirmed, completed or no-show), with their name, email, phone number, status, amount paid (in the event's currency) and when they registered. Sold counts are shown **per tier** (e.g. "VIP — 12 sold / 50"), so you can track take-up across ticket categories at a glance.
- **Cancelled** — everyone whose registration was cancelled, with the same name, email and phone details.

Each table has its own **Download CSV** button, so you can export either list — for example to email attendees, run check-in from a spreadsheet, or follow up with people who cancelled. Email and phone come from the customer's circls account; for registrations without a linked account, whatever contact was captured at booking time is shown.

Use these tables to check turnout and reconcile payments.

## Where to find your events

- **Events** (top-level) shows every event across your whole organisation.
- A venue's **Events** page shows just that venue's events, with quick access to submit, publish-status and cancel actions.
