# Email setup (MSG91, Resend)

The API sends transactional email (team invitations, booking confirmed/cancelled)
through the notifications dispatcher. The email channel has these providers behind
one port (`apps/api/src/lib/notifications/email.ts`), picked in this order:

- **`smtp`** — local sandbox only (`SANDBOX_SMTP_HOST`): everything lands in Mailpit.
- **`msg91`** — real delivery via MSG91 Email. Selected when `MSG91_AUTH_KEY`,
  `MSG91_EMAIL_FROM` and `MSG91_EMAIL_TEMPLATE_ID` are **all** set; it then
  sends **all** email, and Resend is not used. See [MSG91](#msg91) below.
- **`resend`** — real delivery via [Resend](https://resend.com), when MSG91
  email isn't configured. Selected only when **both** `RESEND_API_KEY` and
  `RESEND_FROM` are set.
- **`stub`** — nothing configured. Writes a `notifications` row and logs
  `email_stub`, but **never delivers**. This is why email "doesn't work" out of
  the box.

At boot the API logs `notification_providers` with each channel's mode, e.g.
`{ sms: 'stub', email: 'msg91', whatsapp: 'stub' }`. Check that line first when
debugging delivery.

## MSG91

MSG91 sends only through templates approved in its dashboard, so one generic
transactional template carries every email. We render our plain-text email as
usual and send it as two variables.

1. **Verify the sending domain** (MSG91 → Email → Domains) — the TXT and MX
   records it shows, in DNS. Until it's verified MSG91 only delivers to the
   account's own address.
2. **The generic template** (Email → Templates), HTML source:
   - Subject: `Circls: {{VAR1}}` (MSG91 wants some fixed text in a subject).
   - Body: a `<pre style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif">{{VAR2}}</pre>`
     inside a simple Circls header/footer. The `<pre>` keeps our line breaks.
   - Submit for approval. Its **slug** (e.g. `circls_transactional`, not the numeric id) goes in `MSG91_EMAIL_TEMPLATE_ID`. (Renamed the
     variables `subject`/`body`? That works too — both names are sent.)
3. **Auth key** — the account auth key (profile → Authkey), the same
   `MSG91_AUTH_KEY` SMS uses, with Email allowed in its rule. Only the account
   **owner** can create or edit auth keys. Setting the key does **not** turn
   on SMS: that needs `MSG91_SMS_ENABLED=true` as well, once the SMS flows
   exist in MSG91.
4. **Env (Coolify → api)** — `MSG91_AUTH_KEY`, `MSG91_EMAIL_FROM` (on the
   verified domain, e.g. `Circls <no-reply@event.circls.app>`),
   `MSG91_EMAIL_TEMPLATE_ID`; `MSG91_EMAIL_DOMAIN` only if the registered domain
   isn't the from address's. Setting only some of the three email vars fails
   the boot in production. Redeploy, then check the boot log for
   `email: 'msg91'`.

Failures show as `notification_send_failed` with `msg91_email_send_failed:<status>:…`:
401 is the auth key; `template_id … is not registered` means the numeric id was used instead of the slug, or the template is unknown or unapproved
(e.g. still awaiting approval); a `domain` error is an unverified domain or a from address off it.
MSG91 → Email → **Logs** shows each send by its `unique_id` (stored as the
notification's `provider_message_id`).

The Resend steps below still apply while Resend is the sender, or as the
fallback.

## One-time provisioning (do this once)

You don't have a Resend account yet — follow these steps to create one.

1. **Sign up** at https://resend.com (free tier covers early volume — 3k
   emails/mo, 100/day). Log in.
2. **Add your sending domain.** Dashboard → **Domains → Add Domain** →
   `circls.app` (or a subdomain like `mail.circls.app` to keep DNS isolated
   from the apex).
3. **Add the DNS records Resend shows you** to wherever `circls.app` DNS lives
   (same place you manage `api.circls.app` / `partners.circls.app`):
   - an **MX** record (for the `send.` / bounce subdomain),
   - a **TXT SPF** record,
   - **DKIM** `CNAME`/`TXT` records,
   - (recommended) a **DMARC** TXT record at `_dmarc`.
   Then click **Verify** in Resend. Propagation is usually minutes.
4. **Create an API key.** Dashboard → **API Keys → Create** → scope **Sending
   access**. Copy the `re_…` value — it's shown only once.
5. **Pick your `RESEND_FROM`.** Must be on the verified domain. We left the exact
   address as a deploy-time decision; a good default is:
   `Circls <no-reply@circls.app>`.

## Wire the credentials

**Local dev** — create `apps/api/.env` (gitignored) from the example and fill in:

```bash
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
RESEND_FROM=Circls <no-reply@circls.app>
```

**Production (Coolify)** — Coolify dashboard → the `api` application →
**Environment Variables** → add `RESEND_API_KEY` and `RESEND_FROM` → redeploy.
Store the key in `~/circls-secrets.md` too so it isn't lost.

## Verify it works

After setting both vars, restart the API and confirm the boot log shows
`email: 'resend'`. Then trigger a real send and watch the logs:

- **Invitation:** from the partners portal, invite a teammate to your tenant —
  or `POST /v1/tenants/:id/invitations`. A `notification_send_failed` log line
  (instead of a silent `email_stub`) means the key/domain is wrong.
- Check the **Resend dashboard → Emails** tab for delivery + bounce status.

## Common failure modes

| Symptom | Cause |
|---|---|
| Boot log shows `email: 'stub'` | One of `RESEND_API_KEY` / `RESEND_FROM` is unset. |
| `resend_send_failed:403` | API key invalid or lacks sending scope. |
| `resend_send_failed:422 …domain is not verified` | DNS not verified, or `RESEND_FROM` domain ≠ verified domain. |
| Emails sent but land in spam | Add the DMARC record; warm up volume gradually. |
