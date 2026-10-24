/**
 * Shared shell + building blocks for the designed transactional emails.
 *
 * Every designed email is one standalone HTML document (MSG91 stores each
 * template on its own, with no partials), so the shell is composed here in
 * code and each template module calls `emailDocument()` with its parts. The
 * result is Handlebars source: `{{var}}` (escaped), `{{#if}}` and `{{#each}}`
 * only — no custom helpers, because MSG91 renders the same source with its
 * own Handlebars and knows nothing of ours.
 *
 * Styles are copied from the design file (Circls · Transactional emails):
 * table layout, inline styles, 600px container, web fonts with system
 * fallbacks for clients that ignore <link>.
 */

/** The logo on its own white rounded square (apps/consumer/public/
 *  email-logo.png, 256×256, shown at 64px), served by the consumer site.
 *  The bare logo's black outline vanished on dark backgrounds (Outlook) or
 *  turned into a dark blob (Gmail on iPhone); mail apps never recolour an
 *  image, so the badge looks the same in light and dark mode. Email clients
 *  block `data:` images, so it must be a public URL. */
export const LOGO_URL = 'https://circls.app/email-logo.png';

/** The colour stripe across the top (apps/consumer/public/email-stripe.png,
 *  1200×12, shown 6px tall). An image because Gmail on iPhone squeezed the
 *  equivalent row of empty table cells into a speck, and because mail apps
 *  never recolour images, so it keeps its colours in dark mode. Its cell is
 *  coral underneath, so a reader with images off still gets a bar. */
export const STRIPE_URL = 'https://circls.app/email-stripe.png';

const BRI = "font-family:'Bricolage Grotesque','Helvetica Neue',Helvetica,Arial,sans-serif;";
const JAK = "font-family:'Plus Jakarta Sans','Helvetica Neue',Helvetica,Arial,sans-serif;";
// References (booking, refund, listing ids) in the body font with even-width
// digits: a monospace stack falls back to Courier in many clients.
const REF = 'letter-spacing:.5px;font-variant-numeric:tabular-nums;';
const HAND = "font-family:'Caveat','Bradley Hand',cursive;";

/** Pill + note-box colour pairs used by the designs. */
export const TONES = {
  green: { bg: '#E2F4EA', fg: '#206d3f' },
  orange: { bg: '#FBE3D6', fg: '#a8411b' },
  yellow: { bg: '#FFF3C4', fg: '#6e5300' },
  lilac: { bg: '#E6E7FB', fg: '#3d4170' },
  teal: { bg: '#DDEFF1', fg: '#006476' },
} as const;
export type Tone = keyof typeof TONES;

/** CTA button fills: partners coral, admin lilac/yellow, consumers blue. */
export const CTA_COLORS = {
  coral: '#F77E54',
  lilac: '#CBCEF6',
  yellow: '#FCE38A',
  blue: '#A9C9F2',
} as const;
export type CtaColor = keyof typeof CTA_COLORS;

/**
 * Desktop sizes. Phone sizes are the inline defaults because Gmail on iPhone
 * skips the <style> block; wider screens get these through a min-width
 * media query, and Outlook for Windows (no media queries) through an
 * [if mso] block. Paddings per row, as in the design.
 */
const DESKTOP_CSS = [
  '.px{padding-left:48px!important;padding-right:48px!important}',
  '.pxi{padding-left:64px!important;padding-right:64px!important}',
  '.pxf{padding-left:56px!important;padding-right:56px!important}',
  '.pxo{padding-left:40px!important;padding-right:40px!important}',
  '.cp{padding-left:30px!important;padding-right:30px!important}',
  '.h1{font-size:36px!important;line-height:40px!important}',
  '.hero{font-size:23px!important;line-height:28px!important}',
]
  .map((r) => `    ${r}`)
  .join('\n');

// ── Card pieces (inside the cream details card) ──────────────────────────────

/** Small uppercase label + big value at the top of the card. */
export function cardHero(label: string, value: string): string {
  return (
    `<tr><td colspan="2" style="padding:0 0 4px;${BRI}font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#4a4654">${label}</td></tr>\n` +
    `<tr><td colspan="2" class="hero" style="padding:0 0 14px;border-bottom:1px solid #E9E0D0;${BRI}font-size:20px;line-height:25px;font-weight:800;letter-spacing:-.4px;color:#17151D">${value}</td></tr>\n` +
    `<tr><td colspan="2" style="height:10px;line-height:10px;font-size:0">&nbsp;</td></tr>`
  );
}

/**
 * Label/value rows from a `rows` array of `{ label, value, mono? }`. `mono`
 * sets the value in the monospace style the designs use for references.
 */
export function cardRows(listVar = 'rows'): string {
  return (
    `{{#each ${listVar}}}<tr><td style="padding:7px 0;${JAK}font-size:15px;color:#4a4654">{{label}}</td>` +
    `<td align="right" style="padding:7px 0;${JAK}{{#if mono}}${REF}{{/if}}font-size:15px;font-weight:600;color:#17151D">{{value}}</td></tr>{{/each}}`
  );
}

/** Small uppercase sub-heading inside the card (e.g. "Largest payouts"). */
export function cardSubhead(text: string): string {
  return `<tr><td colspan="2" style="padding:14px 0 6px;${BRI}font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#4a4654">${text}</td></tr>`;
}

/** Divider + bold total line at the bottom of the card. */
export function cardTotal(label: string, value: string): string {
  return (
    `<tr><td colspan="2" style="height:10px;line-height:10px;font-size:0;border-bottom:1px solid #E9E0D0">&nbsp;</td></tr>\n` +
    `<tr><td style="padding:16px 0 0;${JAK}font-size:16px;font-weight:700;color:#17151D">${label}</td>` +
    `<td align="right" style="padding:16px 0 0;${BRI}font-size:24px;font-weight:800;letter-spacing:-.4px;color:#17151D">${value}</td></tr>`
  );
}

/** "18 of 40 spots filled" + progress bar, from `filled`, `total`, `pct`. */
export function cardProgress(objVar: string): string {
  return (
    `<tr><td colspan="2" style="padding:14px 0 2px">\n` +
    `<div style="${JAK}font-size:13px;color:#4a4654;padding-bottom:8px"><strong style="color:#17151D">{{${objVar}.filled}} of {{${objVar}.total}}</strong> spots filled</div>\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EDE3D2;border-radius:999px"><tr>\n` +
    `<td style="width:{{${objVar}.pct}}%;background:#206d3f;border-radius:999px;height:8px;line-height:8px;font-size:0">&nbsp;</td><td style="font-size:0;line-height:8px">&nbsp;</td>\n` +
    `</tr></table></td></tr>`
  );
}

/** Ranked list rows with a sub-line, e.g. organizers and their payouts:
 *  items `{ name, sub, amount, tag? }`. */
export function cardRankedList(listVar: string): string {
  return (
    `{{#each ${listVar}}}<tr><td style="padding:6px 0;border-top:1px solid #E9E0D0;${JAK}font-size:15px;color:#17151D">{{name}}` +
    `<div style="font-size:13px;color:#8a8594">{{sub}}{{#if tag}} &middot; <span style="color:#a8411b;font-weight:600">{{tag}}</span>{{/if}}</div></td>` +
    `<td align="right" valign="top" style="padding:8px 0 6px;border-top:1px solid #E9E0D0;${JAK}font-size:15px;font-weight:700;color:#17151D">{{amount}}</td></tr>{{/each}}`
  );
}

// ── Blocks below the card ────────────────────────────────────────────────────

/** Coloured note box with a title and a body (body may hold markup). */
export function noteBox(tone: Tone, title: string, body: string): string {
  const t = TONES[tone];
  return (
    `<tr><td class="px" style="padding:18px 24px 0">\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${t.bg};border-radius:14px;border-left:4px solid ${t.fg}">\n` +
    `<tr><td style="padding:18px 22px">\n` +
    `<div style="${BRI}font-size:15px;font-weight:700;color:${t.fg};padding-bottom:6px">${title}</div>\n` +
    `<div style="${JAK}font-size:15px;line-height:23px;color:#17151D">${body}</div>\n` +
    `</td></tr></table>\n` +
    `</td></tr>`
  );
}

/** Bulleted list for inside a note box, from an array of strings. */
export function bulletList(listVar: string): string {
  const cell = `${JAK}font-size:15px;line-height:22px;color:#17151D`;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px">\n` +
    `{{#each ${listVar}}}<tr><td valign="top" style="padding:3px 10px 3px 0;${cell}">&#9679;</td><td style="padding:3px 0;${cell}">{{this}}</td></tr>{{/each}}\n` +
    `</table>`
  );
}

/** Inline link styled like the designs' footnote links. */
export function inlineLink(href: string, label: string): string {
  return `<a href="${href}" style="color:#4a4654;text-decoration:underline">${label}</a>`;
}

/** `<strong>` in the ink colour, as used inside intros. */
export const strong = (inner: string): string => `<strong style="color:#17151D">${inner}</strong>`;

// ── Document ─────────────────────────────────────────────────────────────────

export interface EmailParts {
  /** Hidden inbox preview line. */
  preheader: string;
  pill: { tone: Tone; text: string };
  headline: string;
  intro: string;
  /** Rows inside the cream details card (cardHero/cardRows/cardTotal…). */
  card: string;
  /** Note boxes after the card, already wrapped in any conditionals. */
  boxes?: string;
  cta: { href: string; label: string; color: CtaColor };
  /** Grey line under the button (may hold links). */
  footnote?: string;
  /** Hand-written sign-off, without the trailing star. */
  signoff: string;
  /** "You're getting this because…" line. */
  footerReason: string;
  footerLinks: Array<{ href: string; label: string }>;
}

/** The full standalone email document, as Handlebars source. */
export function emailDocument(p: EmailParts): string {
  const tone = TONES[p.pill.tone];
  const links = p.footerLinks
    .map((l) => `<a href="${l.href}" style="color:#4a4654;text-decoration:underline">${l.label}</a>`)
    .join(' <span style="color:#c9c2b5">&middot;</span> ');
  const filler = '&#847;&zwnj;&nbsp;'.repeat(6);

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Circls</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Plus+Jakarta+Sans:wght@400;600;700&family=Caveat:wght@700&display=swap" rel="stylesheet">
<style>
  body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}
  img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
  a{color:inherit}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}
  @media only screen and (max-width:620px){
    .container{width:100%!important}
    .outer{padding:20px 10px!important}
  }
  @media only screen and (min-width:621px){
${DESKTOP_CSS}
  }
</style>
<!--[if mso]><style>
${DESKTOP_CSS}
</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#FAF3E8">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#FAF3E8">${p.preheader}${filler}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FAF3E8" style="background:#FAF3E8">
<tr><td class="outer" align="center" style="padding:40px 16px">

<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #EEE5D5;border-radius:6px;overflow:hidden">
<tr><td bgcolor="#f34f34" style="font-size:0;line-height:0;background:#f34f34"><img src="${STRIPE_URL}" width="598" height="6" alt="" style="display:block;width:100%;max-width:600px;height:6px;border:0"></td></tr>
<tr><td align="center" style="padding:40px 40px 0">
<img src="${LOGO_URL}" width="64" height="64" alt="Circls" style="display:block;width:64px;height:64px">
<div style="padding-top:8px;${BRI}font-size:30px;line-height:32px;font-weight:800;letter-spacing:-1px;color:#17151D">circls</div>
</td></tr>
<tr><td align="center" style="padding:28px 40px 0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${tone.bg};border-radius:999px;padding:8px 20px;${BRI}font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${tone.fg}">${p.pill.text}</td></tr></table>
</td></tr>
<tr><td class="px h1" align="center" style="padding:22px 24px 0;${BRI}font-size:29px;line-height:33px;font-weight:800;letter-spacing:-1px;color:#17151D">${p.headline}</td></tr>
<tr><td class="px pxi" align="center" style="padding:14px 24px 0;${JAK}font-size:17px;line-height:27px;color:#4a4654">${p.intro}</td></tr>
<tr><td class="px" style="padding:30px 24px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAF3E8;border-radius:16px">
<tr><td class="cp" style="padding:26px 22px 24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${p.card}</table>
</td></tr></table>
</td></tr>
${p.boxes ?? ''}
<tr><td align="center" style="padding:34px 40px 0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${CTA_COLORS[p.cta.color]}" style="border-radius:10px;background:${CTA_COLORS[p.cta.color]}">
<a href="${p.cta.href}" target="_blank" style="display:inline-block;padding:15px 40px;${BRI}font-size:17px;font-weight:700;color:#17151D;text-decoration:none;border-radius:10px">${p.cta.label}</a>
</td></tr></table>
</td></tr>
${p.footnote ? `<tr><td class="px pxf" align="center" style="padding:18px 24px 0;${JAK}font-size:14px;line-height:22px;color:#8a8594">${p.footnote}</td></tr>` : ''}
<tr><td align="center" style="padding:30px 40px 44px;${HAND}font-size:22px;font-weight:700;color:#EE5C2B">${p.signoff} &#10022;</td></tr>
</table>

<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
<tr><td class="px pxo" align="center" style="padding:28px 24px 6px;${JAK}font-size:13px;line-height:21px;color:#8a8594">${p.footerReason}</td></tr>
<tr><td align="center" style="padding:0 40px;${JAK}font-size:13px;line-height:21px">${links}</td></tr>
<tr><td align="center" style="padding:18px 40px 0;${JAK}font-size:12px;color:#b3ada2">Circls &middot; Mumbai, India</td></tr>
</table>

</td></tr></table>
</body>
</html>
`;
}
