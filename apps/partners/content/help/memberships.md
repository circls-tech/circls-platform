Memberships are time-bound passes your customers can buy — a monthly unlimited plan, a 10-class pack, a season pass. Each plan is made up of one or more **tiers** (e.g. *Gold*, *Silver*, *Bronze*), and each tier has its own price, duration, benefits and optional capacity — just like ticket tiers on an event. This guide covers creating a plan, editing it, activating and deactivating it, and seeing who has bought it.

## Creating a membership plan

1. Go to **Memberships** in the sidebar and use the **Create a plan** card.
2. Fill in the plan details:
   - **Name** (required) — e.g. *Monthly Unlimited*.
   - **Description** (optional) — a short summary shown above the tiers.
   - **Venue scope**:
     - **All venues (org-wide)** — the plan applies across your whole organisation.
     - A specific venue — the plan applies only there.
   - **Terms & conditions** (optional) — plan terms such as refund/validity/transferability rules.
3. Add at least one **tier** under **Plan tiers**. For each tier set:
   - **Tier name** (required) — e.g. *Gold*.
   - **Price (₹)** — enter `0` for a free tier.
   - **Days** (required) — how long this tier lasts once bought, e.g. `30`.
   - **Capacity** (optional) — leave blank for unlimited, or cap how many can be sold.
   - **Description** (optional) and **Benefits** — add structured perks with **Add benefit**: each row has a **label** (e.g. *Priority booking*) and an optional **detail** line. These render as a clean list on the consumer plan page when the tier is selected.

   Use **+ Add tier** for more tiers (up to 20) and **Remove tier** to drop one. A plan needs at least one tier.
4. Click **Add membership**.

Artwork is added from the **Edit** panel once the plan exists (see below).

You'll see *"Membership created. It's now pending review by Circls before it goes live."* New plans start in **pending review**. The price shown in lists is the cheapest tier (e.g. *from ₹499*).

## Membership statuses

| Status | Meaning | What you can do |
| --- | --- | --- |
| **pending_review** | Awaiting the circls team's approval before it can be sold. | Edit. |
| **active** | Approved and on sale. | View buyers; **Deactivate**. |
| **inactive** | Taken off sale by you. Existing members keep their access until it expires. | Edit; **Activate** to put it back on sale; view buyers. |
| **rejected** | Not approved. Read-only. | — |

## Editing a plan

Click **Edit** on a plan to change its name, description, venue scope, **terms**, and its **tiers** (add, remove, reprice, or change duration/capacity/benefits per tier), and to manage its **artwork**. Editing is available while a plan is **pending review** or **inactive**. To change an **active** plan, deactivate it first, edit, then reactivate. Existing members keep the tier they bought even if you later change or remove it.

### Artwork

In the Edit panel, use **Upload** under **Artwork** to add a single cover image for the plan. Accepted formats are **JPEG, PNG and WebP**, up to **10 MB**. Use **Replace** to swap it or **Remove** to clear it. The artwork shows on the consumer plan page.

## QR membership passes

Turn on **QR tickets** on the plan form to give every buyer a scannable
membership pass, valid for their whole membership period. Membership passes are
typically **multi-use** (optionally capped at a number of scans) and are
checked at the door from the portal's **Check-in** page. Like other plan
fields, the setting is editable while the plan is pending review or inactive,
and changes only affect future purchases. See [QR tickets and door
check-in](/help/qr-tickets).

## Activating and deactivating

- **Deactivate** an active plan to stop new purchases. Customers who already hold the membership keep it until it expires.
- **Activate** an inactive plan to put it back on sale.

## Seeing who has bought a plan

Click **View buyers** on a plan to expand its buyer list. For each member you'll see their name, contact, the **tier** they bought, status, the valid period (start → end date) and when they purchased.

A purchased membership runs for the plan's **duration in days** from the purchase date, then automatically becomes **expired**. Individual memberships can be **active**, **expired** or **cancelled**.

## Tips

- Use **benefits** rows (not just the description) to spell out exactly what the pass includes — they render as a clear list customers read before buying. Add **artwork** and **terms** to build trust.
- Pick the **venue scope** deliberately: org-wide passes work across every location, venue-specific passes don't.
- Deactivating is reversible and protects existing members; use it instead of trying to delete a plan that people already hold.
