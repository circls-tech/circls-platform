The **schedule builder** turns an arena's opening hours into bookable slots. You define a date range, daily hours and slot length, set prices on a visual grid, then release the slots so consumers can book them.

Open it from an arena (the **Reception** / schedule link) or from the onboarding wizard. The URL looks like `/arenas/{arenaId}/schedule`.

## 1. Configure the template

Fill in the configuration card. Every field is required to build a preview:

- **Start date** and **End date** — the range to create slots for. The end date must be on or after the start date.
- **Daily open time** and **Daily close time** — in 24-hour `HH:MM` (for example `06:00` to `22:00`). Open must be before close.
- **Quantization** — the slot length: **30, 60 or 90 minutes**.
- **Default price (₹)** — the starting price applied to every slot, in rupees. Must be zero or more.

Click **Build preview**. If something's off you'll see a clear message (for example *"Daily open time must be before close time."*).

## 2. Shape the week on the grid

The preview shows a representative week (Sunday–Saturday) as a grid: one column per day, one row per slot. Times are shown in the venue's timezone.

- **Click and drag** to select a range of cells.
- With cells selected, the **inspector panel** lets you:
  - **Set a price** for the selected slots and **Apply** it.
  - **Block** the selected slots so they aren't bookable (use this for maintenance windows, leagues, or block-out days), or **Unblock** them again.
- Blocked cells appear greyed out; open cells show their price.

The template repeats every week across your chosen date range, so you only shape one week.

## 3. Release the slots

When the grid looks right, use the **Release schedule** card. It summarises what will be created — for example *"slots from 2025-01-01 to 2025-03-31 using the template above (60-min slots, every day 06:00–22:00)."*

Click **Release schedule**. circls then creates the slots and reports:

- **Created** — how many new slots were added.
- **Skipped (already existed)** — slots that were already present and left untouched.

Releasing is **idempotent**: if you release the same range twice, existing slots are skipped rather than duplicated. You can safely extend a schedule by releasing a later date range later on.

After a successful release, follow **Go to reception view →** to see and manage your live slots.

## Reception view — managing live slots

The reception view (`/arenas/{arenaId}`) shows the actual released slots week by week. Each slot has a status:

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
