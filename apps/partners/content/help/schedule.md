The **schedule builder** turns an arena's opening hours into bookable slots. You define a date range, a set of **pricing bands** (time ranges, each at its own price) and a slot length, fine-tune on a visual grid, then release the slots so consumers can book them.

Open it from an arena (the **Reception** / schedule link) or from the onboarding wizard. The URL looks like `/arenas/{arenaId}/schedule`.

## 1. Configure the template

Fill in the configuration card:

- **Start date** and **End date** — the range to create slots for. The end date must be on or after the start date.
- **Business day starts at** — the time your day begins, in 24-hour `HH:MM`. The day then runs for a full 24 hours from there. Late-night venues should keep the default **03:00**, so a session that ends at 1 or 2am still counts as part of the *same* business day instead of spilling into the next calendar day. Whatever you pick is remembered and is also used by the reception view.
- **Quantization** — the slot length: **30, 60 or 90 minutes**.

### Pricing bands

A **band** is a stretch of the day at a single price. Add as many as you need to describe your pricing — for example:

- `06:00 → 10:00` at ₹400
- `10:00 → 16:00` at ₹600
- `16:00 → 02:00` at ₹800

Each band has a **From** time, a **To** time and a **price (₹)**. Bands apply to **every day** in your date range; you can adjust individual days afterwards on the grid.

- **Overnight bands are fine.** If the **To** time is earlier than (or equal to) the **From** time, the band simply crosses midnight — `16:00 → 02:00` means 4pm through to 2am the next morning.
- **Open 24 hours?** Add a single band whose **To** time equals its **From** time (for example `03:00 → 03:00`). That covers the whole business day.
- Bands must **not overlap**, but **gaps are allowed** — any time not covered by a band simply gets no slots.

Click **Generate preview**. If something's off you'll see a clear message (for example *"Bands overlap. Adjust the times so they don't overlap."*). Your bands and day-start are **saved on release**, so next time you just change the dates and generate again.

## 2. Shape the week on the grid

The preview shows a representative week (Sunday–Saturday) as a grid: one column per day, one row per slot. Rows run from your **business-day start** downward, so an overnight band reads top-to-bottom in one column (e.g. with a 03:00 start the rows go 03:00 … 23:00 … 02:00) and a slot that falls after midnight stays under the day it belongs to rather than jumping to the next column. Times are shown in the venue's timezone by default; a small read-out above the grid tells you which zone is in effect.

You can change the zone times are *displayed* in from the **timezone selector in the top bar** (it applies across the whole portal). This is view-only — slots are always generated and released in the venue's own timezone no matter what you're viewing in. Leave the selector on **Auto** to follow each venue's own time.

- **Click and drag** to select a range of cells.
- With cells selected, the **inspector panel** lets you:
  - **Set a price** for the selected slots and **Apply** it.
  - **Block** the selected slots so they aren't bookable (use this for maintenance windows, leagues, or block-out days), or **Unblock** them again.
- Blocked cells appear greyed out; open cells show their price.

The template repeats every week across your chosen date range, so you only shape one week.

## 3. Release the slots

When the grid looks right, use the **Release schedule** card. It summarises what will be created — for example *"This will create 60-min slots from 2025-01-01 to 2025-03-31 using the 3 pricing bands above."*

Click **Release schedule**. circls then creates the slots and reports:

- **Created** — how many new slots were added.
- **Skipped (already existed)** — slots that were already present and left untouched.

Releasing is **idempotent**: if you release the same range twice, existing slots are skipped rather than duplicated. You can safely extend a schedule by releasing a later date range later on.

After a successful release, follow **Go to reception view →** to see and manage your live slots.

## Reception view — managing live slots

The reception view (`/arenas/{arenaId}`) shows the actual released slots week by week. Like the builder grid, its slot times and day columns follow the **timezone selector in the top bar** — leave it on **Auto** to read the schedule in the venue's own zone, or pick a zone to view the same slots in your local time. This is display-only; it never changes when a slot actually is.

Each slot has a status:

| Status | Meaning |
| --- | --- |
| **open** | Available to book. Shows its price. |
| **held** | Temporarily reserved during checkout. Releases automatically if the hold expires. |
| **booked** | Booked by a customer. |
| **blocked** | Made unavailable by you. |

From here you can:

- **Change prices** on selected slots (you'll be asked to confirm).
- **Block or unblock** slots — applied immediately.
- **Take a booking** on open slots for walk-in / phone customers (reception booking).
- **Cancel a booking** on a booked slot, which frees it again. See [Understanding bookings and cancellations](/help/bookings).

## Tips

- Confirm the venue's **timezone** before releasing — all slot times are interpreted in it.
- Release a manageable window (a month or a quarter) and extend it as you go, rather than years at once.
- Use **blocking** for one-off closures and reserved events; use **suspending the arena** for longer outages.
