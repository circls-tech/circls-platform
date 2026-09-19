Memberships are time-bound passes your customers can buy — a monthly unlimited plan, a 10-class pack, a season pass. Each plan is made up of one or more **tiers** (e.g. *Gold*, *Silver*, *Bronze*), and each tier has its own price, duration, benefits and optional capacity — just like ticket tiers on an event. This guide covers creating a plan, editing it, activating and deactivating it, and seeing who has bought it.

## Creating a membership plan

1. Go to **Memberships** in the sidebar and click **New plan**.
2. Fill in the plan details:
   - **Name** (required) — e.g. *Monthly Unlimited*.
   - **Description** (optional) — a short summary shown above the tiers.
   - **Venue scope**:
     - **All venues (org-wide)** — the plan applies across your whole organisation.
     - A specific venue — the plan applies only there.
   - **Terms & conditions** (optional) — plan terms such as refund/validity/transferability rules.
3. Add at least one **tier** under **Plan tiers**. For each tier set:
   - **Tier name** (required) — e.g. *Gold*.
   - **Price** — enter `0` for a free tier. The field's label shows the plan's currency (₹ or $): a venue-scoped plan uses that venue's currency, an org-wide plan your organisation's — both follow the country on file. US customers pay in dollars via Stripe.
   - **Days** (required) — how long this tier lasts once bought, e.g. `30`.
   - **Capacity** (optional) — leave blank for unlimited, or cap how many can be sold.
   - **Description** (optional) and **Benefits** — add structured perks with **Add benefit**: each row has a **label** (e.g. *Priority booking*) and an optional **detail** line. These render as a clean list on the consumer plan page when the tier is selected.

   Use **+ Add tier** for more tiers (up to 20) and **Remove tier** to drop one. A plan needs at least one tier.
4. Optionally add **Plan artwork** — a single cover image (JPEG, PNG or WebP, up to 10 MB) picked right on the form. It uploads automatically when the plan is created.
5. Click **Create plan**.

Artwork can also be added or changed later while editing the plan (see below).

You land on the new plan's page, where it starts in **pending review** until Circls approves it. The price shown in lists is the cheapest tier (e.g. *from ₹499*, or *from $49* for a US plan).

## The plans list

**Memberships** in the sidebar lists your plans with their scope, a one-line tier summary (*3 tiers · ₹500–₹2,000*) and status. Click a plan's name to open it: everything a plan can do — editing, artwork, activating, and its members — lives on its own page, where there is room for it.

## Membership statuses

| Status | Meaning | What you can do |
| --- | --- | --- |
| **pending_review** | Awaiting the circls team's approval before it can be sold. | Edit. |
| **active** | Approved and on sale. | View buyers; **Deactivate**. |
| **inactive** | Taken off sale by you. Existing members keep their access until it expires. | Edit; **Activate** to put it back on sale; view buyers. |
| **rejected** | Not approved. Read-only. | — |

## Editing a plan

Open a plan from the **Memberships** list — click its name — and click **Edit** there to change its name, description, venue scope, **terms**, and its **tiers** (add, remove, reprice, or change duration/capacity/benefits per tier), and to manage its **artwork**. Editing is available while a plan is **pending review** or **inactive**. To change an **active** plan, deactivate it first, edit, then reactivate. Existing members keep the tier they bought even if you later change or remove it.

### Artwork

Artwork is a single cover image shown on the consumer plan page. You can add it on the **New plan** form (it uploads when the plan is created) or later while editing the plan, where **Upload** adds it, **Replace** swaps it and **Remove** clears it. Accepted formats are **JPEG, PNG and WebP**, up to **10 MB**.

## QR membership passes

Turn on **QR tickets** on the plan form to give every buyer a scannable
membership pass, valid for their whole membership period. Membership passes are
typically **multi-use** (optionally capped at a number of scans) and are
checked at the door from the portal's **Check-in** page. Like other plan
fields, the setting is editable while the plan is pending review or inactive,
and changes only affect future purchases. See [QR tickets and door
check-in](/help/qr-tickets).

### Per-tier QR rules

Because tiers can carry different benefits (more days, more visits), each tier
has its own **QR passes for this tier** setting:

- **Plan default** — the tier follows the plan-level QR settings (this is the
  default for every tier).
- **Custom** — the tier issues passes with its own rules — for example *Gold*
  gets unlimited scans while *Bronze* is capped at 10 visits. Custom rules
  replace the plan-level settings entirely for that tier.
- **Off** — no QR passes for this tier, even when the plan enables them.

A buyer's pass always uses the rules of the tier they bought, frozen at
purchase time — later edits never change passes that are already issued.

## Activating and deactivating

- **Deactivate** an active plan to stop new purchases. Customers who already hold the membership keep it until it expires.
- **Activate** an inactive plan to put it back on sale.

## Managing a plan's members

Open a plan from the **Memberships** list to see its **Members** section. For each member you'll see their name, contact, the **tier** they hold, status, the valid period (start → end date) and when they were added. On a phone the table becomes one card per member.

A purchased membership runs for the plan's **duration in days** from the purchase date. Once it has been over for a full day, circls marks it **expired** automatically — the day's grace means nobody is caught out on their last evening. circls checks twice a day, at 5 am and 5 pm IST, so this happens within a day and a half of the end date. Individual memberships can be **active**, **expired** or **cancelled**; a cancelled one is never changed to expired.

An expired member keeps their seat on the tier, exactly as before — expiry does not free up capacity. They drop out of the customer's own **My memberships** list, just as a cancelled one does.

### Adding someone who joined elsewhere

Signed someone up at the desk, over the phone, or on paper? Click **Reception** beside the plan's name — or **Add member** in that list; both open the same form, and Reception is there so counter staff can reach it in one click. You give their name, an optional contact, which tier they are on, and — if you want something other than the tier's normal run — the dates their membership covers.

They are a real member where it counts: the seat comes out of that tier's capacity, so a tier can sell out because of them, and they appear in the list marked **added by you**.

**They are invisible to money.** circls processed nothing, so the membership never appears in a payout and never attracts commission — whatever they paid, they paid you directly.

### Correcting dates, and cancelling

**Edit dates** on any member lets you change when their membership starts and ends — for a mid-term upgrade, a goodwill extension, or simply a mistake at sign-up. The end date must fall after the start date. Changing a member's dates moves their QR pass with them, so the door always agrees with the membership. Extending an **expired** member's end date into the future renews them: they become **active** again and their pass works at the door.

Two actions end a membership, and which you want depends on the money:

- **Refund** hands back what the member paid and ends the membership. It is offered only where circls actually took the money — a hand-added member paid you directly and a free plan has nothing to give back, so neither shows it. The refund is made in full regardless of how much of the membership has run, the same way a staff-cancelled event registration is, and it is recorded in the audit log.
- **Cancel** ends the membership and frees its seat on the tier, so someone else can take it, but returns no money. Use it when the refund happened elsewhere, or when there was nothing to refund.

Either way, the member's QR pass stops working straight away — the door reads it as **revoked**. Editing a cancelled member's dates does not bring it back. If you reactivate a cancelled member, their pass works again.

## Customer questions

Customers viewing a plan can ask **questions** on it — "Does the pass cover both venues?", "Can I pause it?" — either publicly (shown on the plan's consumer page) or privately. Answer them from the **Questions** inbox in the sidebar. A clear public answer often saves you the same question twice. See [Answering customer questions](/help/questions).

## Tips

- Use **benefits** rows (not just the description) to spell out exactly what the pass includes — they render as a clear list customers read before buying. Add **artwork** and **terms** to build trust.
- Pick the **venue scope** deliberately: org-wide passes work across every location, venue-specific passes don't.
- Deactivating is reversible and protects existing members; use it instead of trying to delete a plan that people already hold.
