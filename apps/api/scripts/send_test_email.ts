/**
 * Send one real test email through the configured senders, outside the app.
 *
 *   pnpm --filter @circls/api email:test -- you@example.com                     # booking confirmation
 *   pnpm --filter @circls/api email:test -- you@example.com listing.approved    # any designed email
 *   pnpm --filter @circls/api email:test -- you@example.com admin.org_signup    # admin email (Resend)
 *
 * Reads the same env as the API (MSG91_* / RESEND_* / MSG91_EMAIL_DESIGNS —
 * see docs/EMAIL_SETUP.md), ignores SANDBOX_SMTP_HOST so it never goes to
 * Mailpit, and sends the design's sample data through the same routing the
 * app uses. Prints the sender and the provider's message id. Nothing is
 * written to the DB.
 */
process.env['SANDBOX_SMTP_HOST'] = '';
process.env['DATABASE_URL'] ??= 'postgres://placeholder@127.0.0.1:5432/placeholder';
process.env['RUN_WORKER'] = 'false';

const [recipient, templateKey = 'booking.confirmed'] = process.argv.slice(2);
if (!recipient || !/.+@.+\..+/.test(recipient)) {
  process.stderr.write('usage: send_test_email.ts <recipient-email> [template-key]\n');
  process.exit(2);
}

const { getEmailProvider } = await import('../src/lib/notifications/email.js');
const { getEmailDesign, msg91TemplateId } = await import('../src/lib/notifications/email_designs/index.js');
const { isInternalTemplateKey } = await import('../src/lib/notifications/templates.js');

const design = getEmailDesign(templateKey);
if (!design) {
  process.stderr.write(`No design for ${templateKey}. Designed keys: booking.confirmed, booking.cancelled, booking.refunded, partner.booking_confirmed, listing.approved, listing.rejected, admin.listing_submitted, admin.payouts_reminder, admin.org_signup\n`);
  process.exit(2);
}

const router = getEmailProvider();
const sender = isInternalTemplateKey(templateKey) ? router.internal : router.external;
const via =
  sender.mode === 'msg91'
    ? `msg91 (${msg91TemplateId(templateKey) ?? 'generic template'})`
    : sender.mode;
process.stdout.write(`${templateKey}: ${via} -> ${recipient}\n`);
if (sender.mode === 'stub') {
  process.stderr.write('That sender is not configured — set its env vars first (docs/EMAIL_SETUP.md).\n');
  process.exit(1);
}
const result = await router.send({ recipient, templateKey, payload: design.sample });
process.stdout.write(`accepted, provider message id: ${result.providerMessageId ?? '(none)'}\n`);
