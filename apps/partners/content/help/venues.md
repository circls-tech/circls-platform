Venues and arenas are the foundation of your circls listing. A **venue** is a physical location; an **arena** is a bookable space inside it. This guide covers adding and editing both, uploading photos, and understanding listing statuses.

## Adding a venue

1. Go to **Venues** in the sidebar and click **+ Add venue**.
2. Fill in:
   - **Venue name** (required).
   - **Timezone** — an IANA timezone such as `Asia/Kolkata`. This defaults to `Asia/Kolkata`. It is the venue's *canonical* zone: slot and booking times are interpreted and scheduled in it. (Separately, the **timezone selector in the top bar** lets you change the zone times are *displayed* in across the portal — a view-only preference that never changes a venue's actual timezone.)
   - **Tags** (optional) — short descriptors like `indoor` or `floodlit`.
3. Save. You'll be taken to the venue's detail page.

New venues start in **pending review**. You can edit details, fill in the address and upload photos while you wait for approval.

## Editing a venue

Open a venue from the **Venues** list to reach its detail page. The **Venue details** panel at the top of that page lets you edit everything customers see and save it in place — name, timezone (read-only here), tags and address, plus the trust details below. You can also manage photos and jump to **Events** and **Bookings**.

### Venue details (description, amenities, hours, contact, address)

These fields appear on your public venue page, so keep them accurate — stale details erode trust.

- **Description** — a free-text summary of the venue and what makes it great (up to 2000 characters).
- **Amenities** — tap the chips to toggle the facilities you offer (parking, restrooms, changing rooms, showers, drinking water, café, equipment rental, first aid, Wi-Fi, lockers, seating, floodlights, air conditioning, wheelchair access, pro shop, coaching). Only this canonical list is accepted.
- **Opening hours** — set an open and close time for each weekday, or tick **Closed** for days you do not operate. Times are in the venue's timezone.
- **Contact** — a public phone number and/or email for the venue.
- **Address** — start typing in **Search address** and pick a suggestion to fill the street, city, state, postal code and country automatically (results are limited to the regions circls serves). You can still edit any field by hand. **Country** is chosen from a dropdown (currently India or the USA). Below the address fields, a **map** shows your venue's location: it centres on the city you've typed, and you can **click the map (or drag the pin) to mark your exact entrance** — recommended, since customers browsing nearby venues and events see exactly this point. If you don't place a pin, the map location is derived from the typed address when you save; there's never a need to enter latitude/longitude by hand. City names you type by hand are tidied automatically: common variants of major cities are stored under one canonical spelling ("Bangalore" or "bombay" become "Bengaluru" and "Mumbai"), and a likely typo shows a **"Did you mean …?"** hint under the City field — click it to accept. Setting the city and country is what places your venue on the map and lets nearby customers find it, so keep them accurate. The country also sets how customers pay online and in what currency: venues in **India** charge in rupees (₹) via **Razorpay**, venues in the **USA** charge in US dollars ($) via **Stripe** — every price field and display across the portal follows the venue's currency.

Click **Save details** to apply. Editing these does not change your venue's approval status.

## Adding and managing arenas

Arenas are created and listed on the venue detail page.

1. On the venue page, use the **Add an arena** form.
2. Provide:
   - **Arena name** (required) — e.g. *Court 1*, *Pool A*.
   - **Sport** (optional).
   - **Capacity** (optional) — the number of people the space holds.
   - **Tags** (optional).
3. Save. Each arena card shows its name, sport, slot duration and status, plus a **Reception** button that opens its live slot grid — see [Schedules and reception](/help/schedule).

A new arena's default slot length is 60 minutes; change it in the [schedule builder](/help/schedule). Arenas also start in **pending review**.

## Uploading photos

Photos appear in your consumer listing, so they matter. Manage them in the **Photos** section of the venue detail page.

- Click **Add photos** and select one or more images. Accepted formats are **JPEG, PNG and WebP**.
- You can upload up to **12 photos** per venue. Uploads run one at a time with a progress indicator.
- The **first photo becomes the cover image** shown in listings. Use **←** and **→** to reorder, or **Make cover** to send a photo straight to the front.
- Each thumbnail shows how that photo is cropped on a listing card. If something important is cut off, click **Crop** and drag the marker onto the part that matters — the preview updates live. Cropping never changes your file, and the full photo is always shown uncropped on the public venue page.
- Click **Delete** under a photo to remove it. Deletion is permanent and removes the file from storage; if you delete the cover, the next photo becomes the cover.

## Listing statuses

Both venues and arenas move through the same set of statuses:

| Status | What it means |
| --- | --- |
| **pending review** | New or recently edited listing awaiting the circls team's approval. Not yet visible to consumers. |
| **active** | Approved and live. Visible and bookable by consumers. |
| **closed** (suspended) | Taken off the consumer portal — see [Closing a venue](#closing-a-venue). Not bookable online while closed. |
| **rejected** | The listing was not approved. Review the feedback, make changes, and it can be re-reviewed. |

Consumers only ever see **active** arenas inside **active** venues. If something isn't showing up publicly, check its status here first.

The **Venues** page has two tabs. **Active** holds your live venues and any awaiting review; **Closed & rejected** holds the ones that aren't on the consumer portal, so they don't crowd the venues you're running.

## Closing a venue

Use **Close venue** at the top of a venue's page when it's shutting — for renovation, for the season, or for good. Closing takes it off the consumer portal and stops new online bookings. Nothing is deleted.

**Closing doesn't cancel existing bookings.** The confirmation tells you how many upcoming court bookings the venue still has — contact or cancel those customers from **View bookings** — and how many upcoming events it hosts, with their registrations. Those events come off the consumer portal while the venue is closed: existing registrations stay valid, but no one new can register.

**Reopen venue** puts it back exactly where it was before you closed it:

- A venue that was **live** goes live again straight away.
- One you closed while it was **awaiting review** goes back to review.
- A **rejected** venue comes back rejected — reopening never gets round circls review.
- A venue closed before circls recorded this goes back to review, to be safe.

### Closing one arena

To take a single court or space out of use while the rest of the venue stays open, use **Close arena** on that arena's reception page. It works exactly like closing a venue: the arena stops taking online bookings, nothing is deleted or cancelled, the confirmation counts that arena's upcoming bookings, and **Reopen arena** puts it back where it was. A closed arena shows as **Closed** in its venue's arena list.

## Customer questions

Customers can ask **questions** on your arenas — publicly (visible to everyone browsing the venue) or privately. They land in the **Questions** inbox in the sidebar, tagged with the arena they're about, and answering there is how you respond. See [Answering customer questions](/help/questions).

## Tips

- Set the correct **timezone** before releasing slots — it governs how every time is interpreted.
- Add clear photos and descriptive tags; they improve how your venue ranks and reads in the consumer app.
- Close rather than delete when a venue is temporarily unavailable, so your schedule and history are preserved.
