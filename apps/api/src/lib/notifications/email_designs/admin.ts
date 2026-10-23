/**
 * Circls admin-team emails: review request, payout reminders, new organizer.
 * Resend sends them as HTML rendered here (no MSG91 template — see
 * EmailDesign.msg91Slug).
 */
import {
  cardHero,
  cardRankedList,
  cardRows,
  cardSubhead,
  cardTotal,
  emailDocument,
  noteBox,
  strong,
} from './layout.js';
import type { EmailDesign } from './types.js';

// ── Review request ───────────────────────────────────────────────────────────
// Variables: tenantName, listingType, listingTypeLabel, listingName, rows[],
// resubmission?, reviewUrl, queueCount, oldestAge, preheader.

export const adminListingSubmitted: EmailDesign = {
  key: 'admin.listing_submitted',
  name: 'Circls · Admin: review request',
  subject: '[Review] {{listingTypeLabel}} · {{listingName}} — {{tenantName}}',
  html: emailDocument({
    preheader: '{{preheader}}',
    pill: { tone: 'yellow', text: 'Review requested' },
    headline: 'New {{listingType}} to review.',
    intro: `${strong('{{tenantName}}')} submitted ${strong('{{listingName}}')} for approval.{{#if resubmission}} This is a resubmission.{{/if}}`,
    card: cardHero('Listing', '{{listingName}}') + cardRows(),
    cta: { href: '{{reviewUrl}}', label: 'Review now', color: 'lilac' },
    footnote: '<strong style="color:#4a4654">{{queueCount}}</strong> {{#if queueOne}}item{{else}}items{{/if}} waiting in the queue &middot; oldest {{oldestAge}}',
    signoff: 'keep the circles turning',
    footerReason: 'Admin notification &middot; review requests.',
    footerLinks: [
      { href: '{{adminUrl}}/listings', label: 'Review queue' },
      { href: '{{adminUrl}}/dashboard', label: 'Admin dashboard' },
    ],
  }),
  text:
    '{{tenantName}} submitted the {{listingType}} "{{listingName}}" for approval.\n\n' +
    '{{#each rows}}{{label}}: {{value}}\n{{/each}}\n' +
    '{{queueCount}} waiting in the queue · oldest {{oldestAge}}\n\n' +
    'Review it: {{reviewUrl}}\n',
  sample: {
    preheader: 'Mumbai · ₹399 · 6 in queue',
    tenantName: 'Sunrise Run Club',
    listingType: 'event',
    listingTypeLabel: 'Event',
    listingName: 'Sunday 10K Social',
    rows: [
      { label: 'Type', value: 'Event' },
      { label: 'Organizer', value: 'Sunrise Run Club' },
      { label: 'Submitted by', value: 'Priya Nair (priya@sunriserun.in)' },
      { label: 'City', value: 'Mumbai' },
      { label: 'Price', value: '₹399 / ticket' },
      { label: 'Starts', value: 'Sun 12 Oct, 6:00 AM' },
      { label: 'Listing ID', value: 'EV-5512-0B3D', mono: true },
    ],
    reviewUrl: 'https://admin.circls.app/listings?type=event',
    queueCount: 6,
    queueOne: false,
    oldestAge: '19 hours',
  },
};

// ── Payout reminders (Tuesday heads-up, Wednesday payout day) ───────────────
// One template; `payoutDay` switches the Wednesday copy on. Variables:
// payoutDay, payoutDateLabel, cycleLabel, orgCount, bookingCount, feesText,
// top[{name, sub, amount, tag?}], totalText, onHold? {count, names},
// payoutsUrl, preheader.

export const adminPayoutsReminder: EmailDesign = {
  key: 'admin.payouts_reminder',
  name: 'Circls · Admin: payout reminder',
  subject:
    '[Payouts] {{#if payoutDay}}Today — {{totalText}} still awaiting approval{{else}}Due tomorrow — {{totalText}} across {{orgCount}} organizers{{/if}}',
  html: emailDocument({
    preheader: '{{preheader}}',
    pill: { tone: 'yellow', text: '{{#if payoutDay}}Payout day · Wed{{else}}Payout heads-up · Tue{{/if}}' },
    headline: '{{#if payoutDay}}It’s payout day.{{else}}Payouts go out tomorrow.{{/if}}',
    intro:
      '{{#if payoutDay}}This batch hasn’t been approved yet. Approve before noon so organizers are paid today.' +
      '{{else}}Here’s this week’s batch. Review and approve by end of day so transfers can run Wednesday morning.{{/if}}',
    card:
      cardHero('Payout date', '{{payoutDateLabel}}') +
      cardRows() +
      `{{#if top}}${cardSubhead('Largest payouts')}\n${cardRankedList('top')}{{/if}}` +
      cardTotal('Total to pay out', '{{totalText}}'),
    boxes: `{{#if onHold}}${noteBox(
      'orange',
      '{{onHold.count}} on hold',
      'Missing bank / KYC details: {{onHold.names}}. These are excluded from the total until resolved.',
    )}{{/if}}`,
    cta: { href: '{{payoutsUrl}}', label: 'Review payouts', color: 'yellow' },
    footnote:
      '{{#if payoutDay}}Approved already? Ignore this — transfers are queued.{{else}}Wednesday’s reminder goes out at 9:00 AM if anything is still pending.{{/if}}',
    signoff: 'keep the circles turning',
    footerReason: 'Admin notification &middot; scheduled payout reminders (Tue &amp; Wed, 9:00 AM IST).',
    footerLinks: [
      { href: '{{adminUrl}}/payouts', label: 'Payouts' },
      { href: '{{adminUrl}}/dashboard', label: 'Admin dashboard' },
    ],
  }),
  text:
    '{{#if payoutDay}}It’s payout day — this batch hasn’t been marked paid yet.{{else}}Payouts go out tomorrow ({{payoutDateLabel}}).{{/if}}\n\n' +
    '{{#each rows}}{{label}}: {{value}}\n{{/each}}' +
    '{{#if top}}\nLargest payouts:\n{{#each top}}- {{name}} — {{amount}} ({{sub}}{{#if tag}}, {{tag}}{{/if}})\n{{/each}}{{/if}}\n' +
    'Total to pay out: {{totalText}}\n\n' +
    'Review payouts: {{payoutsUrl}}\n',
  sample: {
    preheader: 'Review and approve by end of day. 23 organizers this week.',
    payoutDay: false,
    payoutDateLabel: 'Wed 8 Oct',
    rows: [
      { label: 'Cycle', value: '29 Sep – 5 Oct' },
      { label: 'Organizers', value: '23' },
      { label: 'Bookings', value: '412' },
      { label: 'Platform fees', value: '₹20,480' },
    ],
    top: [
      { name: 'Bandra Sports Club', sub: '96 bookings', amount: '₹42,600' },
      { name: 'Sunrise Run Club', sub: '71 bookings', amount: '₹28,320' },
      { name: 'Clay & Kiln Studio', sub: '18 bookings', amount: '₹21,060', tag: 'first payout' },
    ],
    orgCount: 23,
    totalText: '₹1,84,350',
    payoutsUrl: 'https://admin.circls.app/payouts',
  },
};

// ── New organizer ────────────────────────────────────────────────────────────
// Variables: tenantName, city?, source?, rows[], weekCount, orgUrl, preheader.

export const adminOrgSignup: EmailDesign = {
  key: 'admin.org_signup',
  name: 'Circls · Admin: new organizer',
  subject: '[New org] {{tenantName}}{{#if city}} · {{city}}{{/if}}',
  html: emailDocument({
    preheader: '{{preheader}}',
    pill: { tone: 'teal', text: 'New organizer' },
    headline: '{{tenantName}} just joined.',
    intro: `A new organizer signed up{{#if source}} via ${strong('{{source}}')}{{/if}}. Give them a once-over.`,
    card: cardHero('Organizer', '{{tenantName}}') + cardRows(),
    cta: { href: '{{orgUrl}}', label: 'View organizer', color: 'lilac' },
    footnote: '<strong style="color:#4a4654">{{weekCount}}</strong> new {{#if weekOne}}organizer{{else}}organizers{{/if}} this week',
    signoff: 'welcome to the circle',
    footerReason: 'Admin notification &middot; new organizer sign-ups.',
    footerLinks: [
      { href: '{{adminUrl}}/tenants', label: 'All organizers' },
      { href: '{{adminUrl}}/dashboard', label: 'Admin dashboard' },
    ],
  }),
  text:
    'A new organizer signed up: {{tenantName}}.\n\n' +
    '{{#each rows}}{{label}}: {{value}}\n{{/each}}\n' +
    '{{weekCount}} new this week.\n\n' +
    'View organizer: {{orgUrl}}\n',
  sample: {
    preheader: 'Mumbai · Owner Meera Shah',
    tenantName: 'Clay & Kiln Studio',
    city: 'Mumbai',
    rows: [
      { label: 'City', value: 'Mumbai' },
      { label: 'Country', value: 'India' },
      { label: 'Contact', value: 'Meera Shah' },
      { label: 'Email', value: 'hello@claykiln.in' },
      { label: 'Phone', value: '+91 98200 12345' },
      { label: 'Org ID', value: 'ORG-4471-9C2E', mono: true },
    ],
    weekCount: 5,
    weekOne: false,
    orgUrl: 'https://admin.circls.app/tenants/0193a2b4-0000-7000-8000-000000004471',
  },
};
