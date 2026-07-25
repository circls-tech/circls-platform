The **schedule builder** turns an arena's opening hours into bookable slots. You define a date range, a set of **pricing bands** (time ranges, each at its own price) and a slot length, fine-tune on a visual grid, then release the slots so consumers can book them.

Open it from an arena (the **Reception** / schedule link) or from the onboarding wizard. The URL looks like `/arenas/{arenaId}/schedule`.

## 1. Configure the template

Fill in the configuration card:

- **Start date** and **End date** — the range to create slots for. The end date must be on or after the start date.
- **Business day starts at** — the time your day begins, in 24-hour `HH:MM`. The day then runs for a full 24 hours from there. Late-night venues should keep the default **03:00**, so a session that ends at 1 or 2am still counts as part of the *same* business day instead of spilling into the next calendar day. Whatever you pick is remembered and is also used by the reception view.
- **Quantization** — the slot length: **30, 60 or 90 minutes**.

### Pricing bands

A **band** is a stretch of the day at a single price. Add as many as you need to describe your pricing — for example:

- `06:00 → 10:00` at 400
- `10:00 → 16:00` at 600
- `16:00 → 02:00` at 800

Each band has a **From** time, a **To** time and a **price**. Prices are in your **venue's currency** — the Price field's label shows the symbol (₹ for venues in India, $ for venues in the USA, driven by the venue's **Country**). Bands apply to **every day** in your date range; you can adjust individual days afterwards on the grid.

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
- If the date range already has released slots, any **booked** slots appear dimmed in the preview at their real position. They can't be selected or edited — releasing never changes a booked slot.

The template repeats every week across your chosen date range, so you only shape one week.

Below the grid, a **"Changes vs the current schedule"** panel compares your plan with what is already released — how many slots would be created, repriced (grouped as *from → to* with a count, e.g. *Price ₹100 → ₹200 for 40 slots*), blocked, unblocked, or removed, and how many booked slots stay exactly as they are. These numbers are an estimate; the release itself reports the exact ones.

## 3. Release the slots

When the grid looks right, use the **Release schedule** card and click **Release schedule**.

Releasing **applies your plan to the selected dates** — it doesn't just add slots, it also updates the schedule that's already there:

- **New slots are created** where the plan has a slot and nothing exists yet.
- **Existing unbooked slots are updated in place** — repriced, blocked or unblocked to match the plan.
- **Existing unbooked slots that no longer fit the plan are removed** (for example after you change band times or shrink the hours).
- **Booked and held slots are never touched** — they keep their time, price and status, whatever the plan says. A new plan slot that would overlap a booked slot is skipped.
- **Slots in the past are never touched.**

After the release you get an exact summary of everything that happened: created, price changes (*from → to* with counts), blocked / unblocked, removed, booked slots kept, and slots skipped because they overlap a booking.

Releasing the same range twice with the same plan changes nothing ("already match — untouched"). You can safely extend a schedule by releasing a later date range later on.

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
