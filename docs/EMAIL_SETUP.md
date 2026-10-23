# Email setup (MSG91 + Resend)

The API sends email through the notifications dispatcher
(`apps/api/src/lib/notifications/`). Two senders, picked per email by its
template key:

| Audience | Emails | Sender |
|---|---|---|
| **Customers** | booking confirmed, booking cancelled (incl. a cancelled event), refund, booking moved, question replies | **MSG91 Email** |
| **Partners** (org contact email, else its owners) | new booking, listing approved, listing needs changes, new question, team invitation | **MSG91 Email** |
| **Circls admin team** (`ADMIN_TEAM_EMAILS`) | listing submitted for review, new organiser, payout reminders (Tue + Wed 9:00 IST), daily summary (08:00 IST) | **Resend** |

Each sender carries the other's mail while only one is configured (with a boot
warning). With neither, email runs in **stub** mode: a `notifications` row is
written and `email_stub` logged, nothing delivered. Half-configuring a sender
fails the boot in production. In the sandbox (`SANDBOX_SMTP_HOST`) everything
goes to Mailpit, admin mail included (`ADMIN_TEAM_EMAILS=ops@sandbox.local`).

The boot log line `notification_providers` shows the senders, e.g.
`{ sms: 'stub', email: 'msg91', emailInternal: 'resend', whatsapp: 'stub' }`
(`email` = customer/partner, `emailInternal` = admin). Check it first.

## Designed emails

Nine emails have a branded HTML design (`lib/notifications/email_designs/`):
booking confirmed / cancelled / refunded, partner new booking, listing approved,
listing needs changes, and the three admin emails. The rest are plain text.

- **Resend** (admin) and **Mailpit** get the HTML rendered by the API.
- **MSG91** sends only through templates stored in its dashboard and renders
  them itself (Handlebars). The six customer/partner designs each have their
  own MSG91 template, named by its slug (`circls_booking_confirmed`, …). A
  design uses its template only once **switched on** in
  `MSG91_EMAIL_DESIGNS`; until then it goes through the generic template as
  plain text, so nothing fails while a template awaits approval.
- Emails without a design always use the generic template.

Preview every design with sample data:
`pnpm --filter @circls/api email:preview -- email-previews.html`.

## MSG91 (customer + partner email)

1. **Sending domain** — MSG91 → Email → Domains: add it (Circls uses
   `event.circls.app`), put the TXT and MX records in DNS, verify. Until it's
   verified MSG91 only delivers to the account's own address.
2. **Auth key** — only the account **owner** can create one (profile →
   Authkey). Its rule needs Email → Templates (view; add/edit to create
   templates by script) and Logs. "Outbound Mails → Send" is "Coming soon" and
   isn't needed. The same key serves SMS, but SMS stays off unless
   `MSG91_SMS_ENABLED=true`.
3. **Generic template** — `circls_transactional`, approved. Subject
   `Circls: {{{VAR1}}}` (three braces, so "&" and apostrophes in a subject
   aren't HTML-escaped; MSG91 wants some fixed text in a subject), body
   `<pre style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif">{{VAR2}}</pre>`
   inside a simple header/footer. `MSG91_EMAIL_TEMPLATE_ID` is its **slug**,
   not its numeric id (the number fails with "… is not registered").
4. **Design templates** — create all six through the API (no pasting):
   ```bash
   pnpm --filter @circls/api email:msg91-templates create
   pnpm --filter @circls/api email:msg91-templates list
   ```
   `list` shows each one as `pending`, `approved` or `rejected`. MSG91 has no
   update API: to change a template later, `export <dir>` and paste the HTML
   into the dashboard's source editor (the left pane — the rich editor
   mangles pasted code). If a template ends up with a different slug, map it
   with `MSG91_EMAIL_TEMPLATES=booking.confirmed=that-slug`.
5. **Switch approved designs on** — `MSG91_EMAIL_DESIGNS=all`, or a list of
   keys as they're approved, e.g.
   `booking.confirmed,booking.cancelled,booking.refunded`. Redeploy.

## Resend (admin email)

Verified sending domain, an API key with sending access, `RESEND_FROM` on that
domain, and `ADMIN_TEAM_EMAILS` (comma-separated). Free tier: 3k/month,
100/day — plenty for admin mail once customer mail is on MSG91.

## Settings (Coolify → `api`)

```bash
MSG91_AUTH_KEY=…                                   # owner-created key
MSG91_EMAIL_FROM=Circls <no-reply@event.circls.app>
MSG91_EMAIL_TEMPLATE_ID=circls_transactional       # slug of the generic template
MSG91_EMAIL_DESIGNS=all                            # once the six are approved
RESEND_API_KEY=re_…
RESEND_FROM=Circls Ops <ops@circls.app>
ADMIN_TEAM_EMAILS=founders@circls.app,ops@circls.app
EMAIL_REPLY_TO=support@circls.app                  # optional; enables "just reply" lines
```

Optional: `MSG91_EMAIL_DOMAIN` (when the registered domain isn't the from
address's), `MSG91_EMAIL_TEMPLATES` (slug overrides), `MSG91_SMS_ENABLED`.
Local runs read the same names from `apps/api/.env` (gitignored).

## Verify

- **One real email per template**, outside the app (sample data, no DB):
  ```bash
  pnpm --filter @circls/api email:test -- you@example.com booking.confirmed
  pnpm --filter @circls/api email:test -- you@example.com admin.org_signup
  ```
  It prints which sender and template it used, and the provider's message id.
- **In the app** — the partner portal's Settings → Notifications lists every
  email with its status; failures show the provider's error. MSG91 → Email →
  Logs shows delivery by the `unique_id` stored as the row's
  `provider_message_id`; Resend → Emails likewise.

## Common failure modes

| Symptom | Cause |
|---|---|
| Boot log `email: 'stub'` | No MSG91 email (or Resend) configured. |
| Boot log `email: 'resend'` | MSG91 email unset — customer mail is using the Resend quota. |
| `msg91_email_send_failed:401` | Wrong auth key, or its rule lacks Email. |
| `… template_id … is not registered` | Numeric id instead of the slug, a design switched on before its template exists/is approved, or a template under another slug (map it with `MSG91_EMAIL_TEMPLATES`). |
| `msg91_email_send_failed:… domain …` | From address not on a verified domain, or `MSG91_EMAIL_DOMAIN` wrong. |
| Subject shows `&amp;` or `&#x27;` | The template subject uses `{{…}}`; use `{{{…}}}`. |
| Designed email arrives as plain text | Its key isn't in `MSG91_EMAIL_DESIGNS` yet. |
| `resend_send_failed:403` / `422 …domain…` | Resend key or domain. |
| No admin mail at all | `ADMIN_TEAM_EMAILS` unset. |
| Images missing in a designed email | The logo is served from the consumer site (`/email/circls-logo.png`); deploy it. |
