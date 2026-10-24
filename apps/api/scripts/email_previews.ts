/**
 * Render every designed email with its sample data into one HTML page, to
 * review the designs side by side (and to compare with the source design).
 *
 *   pnpm --filter @circls/api email:preview -- [out.html]
 *
 * Uses the same renderer as the senders; links point at the production
 * portals. Writes nothing else.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env['DATABASE_URL'] ??= 'postgres://placeholder@127.0.0.1:5432/placeholder';

const { EMAIL_DESIGNS, renderDesign } = await import('../src/lib/notifications/email_designs/index.js');
const { LOGO_URL, STRIPE_URL } = await import('../src/lib/notifications/email_designs/layout.js');

// The emails link to the logo and stripe on the consumer site; inline the
// repo's copies so the preview works offline and before a deploy.
const inline = (name: string, url: string): string => {
  const file = fileURLToPath(new URL(`../../consumer/public/${name}`, import.meta.url));
  return existsSync(file) ? `data:image/png;base64,${readFileSync(file).toString('base64')}` : url;
};
const logoSrc = inline('email-logo.png', LOGO_URL);
const stripeSrc = inline('email-stripe.png', STRIPE_URL);

const out = process.argv[2] ?? 'email-previews.html';
const shared = {
  consumerUrl: 'https://circls.app',
  partnersUrl: 'https://partners.circls.app',
  adminUrl: 'https://admin.circls.app',
  canReply: true,
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Extra variants worth seeing next to each sample.
const variants: Array<{ key: string; label: string; vars: Record<string, unknown> }> = [
  {
    key: 'booking.cancelled',
    label: 'cancelled by the customer, refunded',
    vars: { eventCancelled: false, byCustomer: true, organizerRefundPending: false, refundText: '₹600' },
  },
  {
    key: 'booking.cancelled',
    label: 'cancelled by the venue, cash refund at the venue',
    vars: {
      eventCancelled: false,
      byCustomer: false,
      organizerRefundPending: false,
      orgName: 'Bandra Sports Club',
      placeName: 'Bandra Sports Club',
      refundText: '₹1,200',
      refundAtVenue: true,
    },
  },
  { key: 'admin.payouts_reminder', label: 'Wednesday, payout day', vars: { payoutDay: true } },
];

const cards: string[] = [];
for (const d of EMAIL_DESIGNS) {
  const runs = [{ label: 'sample', vars: {} as Record<string, unknown> }, ...variants.filter((v) => v.key === d.key)];
  for (const run of runs) {
    const r = renderDesign(d, { ...shared, ...d.sample, ...run.vars });
    r.html = r.html.split(LOGO_URL).join(logoSrc).split(STRIPE_URL).join(stripeSrc);
    const who = d.key.startsWith('admin.') ? 'Admin · Resend' : `MSG91 · ${d.msg91Slug}`;
    cards.push(`<article><header><h3>${esc(d.name)} <small>(${esc(run.label)})</small></h3>
<p><b>Key:</b> ${esc(d.key)} · <b>Sender:</b> ${esc(who)}</p><p class="subj"><b>Subject:</b> ${esc(r.subject)}</p></header>
<iframe loading="lazy" srcdoc="${esc(r.html)}" onload="this.style.height=this.contentDocument.body.scrollHeight+'px'"></iframe></article>`);
  }
}

writeFileSync(
  out,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Circls Emails</title>
<style>
body{margin:0;background:#FAF3E8;color:#17151D;font-family:system-ui,sans-serif}
.wrap{max-width:1340px;margin:0 auto;padding:32px 16px 80px}
h1{margin:0 0 6px} .sub{color:#4a4654;margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,640px),1fr));gap:24px}
article{border:2px solid #17151D;border-radius:16px;background:#fff;overflow:hidden}
article header{padding:14px 18px;border-bottom:2px solid #17151D}
h3{margin:0;font-size:1.05rem} small{font-weight:400;color:#4a4654}
article p{margin:4px 0 0;font-size:.85rem;color:#4a4654} .subj{font-family:ui-monospace,Menlo,monospace}
iframe{display:block;width:100%;height:1100px;border:0;background:#FAF3E8}
</style></head><body><div class="wrap"><h1>Circls · Transactional emails</h1>
<p class="sub">Rendered by the API's own templates with sample data.</p>
<div class="grid">${cards.join('\n')}</div></div></body></html>\n`,
);
process.stdout.write(`Wrote ${cards.length} previews to ${out}\n`);
