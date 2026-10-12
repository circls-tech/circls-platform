You can invite colleagues to your organisation, give them a role that controls what they can do, and remove them when needed. Manage everything from **Settings → Team**.

## Roles

Every member has one of four roles:

| Role | What they can do |
| --- | --- |
| **Owner** | Full control — manage the team and roles, manage all venues, arenas, schedules, pricing, bookings, events, memberships and discounts, answer and manage [customer questions](/help/questions), view financial reports, issue refunds, manage [API keys](/help/api-keys), and update or delete the organisation. |
| **Manager** | Everything an Owner can do — team and roles, venues, schedules, pricing, bookings, events, financial reports, refunds and API keys. The exceptions: a Manager cannot delete the organisation, and cannot make anyone an Owner or change or remove an Owner. |
| **Staff** | Day-to-day operations — create and cancel bookings (cancelling one paid online refunds the customer in full), run the event door and membership desks (add registrations and members; renew, cancel or refund members), check customers in, view analytics, and reply to and manage customer questions. Can view venues, arenas, schedules, pricing, events and membership plans, but cannot change them — including slot prices and blocking slots on the reception grid. No team management, no API keys or webhooks, and no access to financial reports. |
| **Read-only** | View-only access to everything except API keys and webhooks (venues, bookings, events, memberships, analytics, financial reports, customer questions). Cannot create, change or delete anything — including replying to questions, or taking, cancelling and refunding bookings. The one exception: they can check customers in at the door, so a door volunteer only needs this role. |

"Financial reports" above means the [Earnings](/help/earnings) page, which shows what circls will pay you. Owners, Managers and Read-only members see it in the sidebar; Staff do not.

Choose the least-privileged role that lets someone do their job — you can always upgrade them later. These descriptions are also shown on the **Settings → Team** page itself, and next to the role picker when you send an invite.

## Inviting a colleague

1. Go to **Settings → Team**.
2. In **Invite a teammate**, enter the colleague's **email** and pick a **role**. You can offer any role up to your own, so only an Owner can invite another Owner.
3. Click **Send invitation**.

An invite link is generated (and emailed to them). It's shown to you in a highlighted box so you can copy and share it directly if you prefer. **Invitations expire after 7 days.**

### Accepting an invite

The invited person opens the invite link, which shows the organisation name and the role they've been offered. What happens next depends on whether they already use circls:

- **New to circls** — they set a password to create their account, click **Accept invitation**, and are added to your organisation with the assigned role. Because the invite link was sent to their email, accepting it confirms their address automatically — there's no separate "verify your email" step.
- **Already have a circls account** — the link asks them to **log in** instead of signing up (so they don't hit an "email already exists" error). After logging in they're added to your organisation. If they're already signed in as that email, it's a single click.
- **Already a member of this organisation** — the link tells them they're already a member and there's nothing to accept. If the invite was for a **higher** role than they currently hold, accepting upgrades them to that role; an invite for the same or a lower role leaves their role unchanged.

## Managing pending invitations

Pending invites appear under **Pending invitations**. Owners and managers can:

- **Resend** — re-issues the email and extends the expiry (the old link is replaced). Managers can't resend an invitation to become an Owner.
- **Revoke** — invalidates the invite link so it can no longer be used.

## Changing a role

Owners and managers can change roles: in the **Members** list, use the **role** dropdown next to a person and pick a new role. The change applies immediately. Nobody can give a role above their own, or change the role of someone above them — so only an Owner can make someone an Owner or change an Owner's role, and a Manager sees an Owner's role without a dropdown.

## Editing a member's name

Invitations only carry an email address, so a teammate who accepted an invite may show up without a name. Owners and managers can fill this in for them:

1. In the **Members** list, click **Edit** next to the person.
2. Set their **name** and click **Save**. Leaving it blank clears it.

As with roles, nobody can edit someone above them — a Manager can't rename an Owner (a name shows everywhere that person appears on circls, not just in your organisation). Any member can edit their own entry, whatever their role.

A member's **phone number** can't be typed in here — phone numbers on circls always come from the person themselves verifying the number with an OTP (for example when they sign in to the circls consumer app). When a member has a verified number it appears alongside their name automatically.

## Removing a member

Owners and managers can remove members: in the **Members** list, click **Remove** next to the person and confirm. Their access is revoked immediately — there's no grace period — so double-check before removing an owner or manager. Only an Owner can remove another Owner, and the last Owner can't be removed. Any member can remove themselves to leave the organisation.

## If your organisation is suspended

Circls can suspend an organisation — for example over an unpaid bill or a policy issue. While it is suspended, a banner says so at the top of every page, and every member, whatever their role, can still **view** what their role lets them see: bookings, customers, events, memberships, reports, and (for Owners and Managers) API keys and webhooks. Nothing about the organisation can be **changed**: no new bookings or registrations, cancellations or refunds, edits, replies to customer questions, invitations (pending ones can't be accepted either), role changes, API keys or webhooks, and passes can be looked up at the door but not admitted. If the organisation still owes an acceptance of the Partner Terms, that waits until it's reinstated too. Customers can still cancel their own bookings, members can still edit their own name or leave, and you can still raise a support issue with Circls from the Help page.

## Tips

- Keep at least one **owner** on the organisation at all times.
- Give aggregator integrations an [API key](/help/api-keys) rather than a user account — keys have their own scoped roles and can be revoked independently.
