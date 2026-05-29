# Email setup (Resend)

The API sends transactional email (team invitations, booking confirmed/cancelled)
through the notifications dispatcher. The email channel has two providers behind
one port (`apps/api/src/lib/notifications/email.ts`):

- **`stub`** — default. Writes a `notifications` row and logs `email_stub`, but
  **never delivers**. This is why email "doesn't work" out of the box.
- **`resend`** — real delivery via [Resend](https://resend.com). Selected only
  when **both** `RESEND_API_KEY` and `RESEND_FROM` are set.

At boot the API logs `notification_providers` with each channel's mode, e.g.
`{ sms: 'stub', email: 'resend', whatsapp: 'stub' }`. Check that line first when
debugging delivery.

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
