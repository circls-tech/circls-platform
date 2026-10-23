/**
 * Partner (organisation) emails: new booking, listing approved, listing needs
 * changes. Sent by MSG91 from its stored copy of each template, to the org's
 * contact email (else its owners).
 */
import {
  bulletList,
  cardHero,
  cardProgress,
  cardRows,
  cardTotal,
  emailDocument,
  noteBox,
  strong,
} from './layout.js';
import type { EmailDesign } from './types.js';

const PARTNER_FOOTER_REASON = (why: string) =>
  `You&rsquo;re getting this because ${why}. <a href="{{partnersUrl}}/settings/organization" style="color:#4a4654;text-decoration:underline">Email settings</a>`;
const PARTNER_FOOTER_LINKS = [
  { href: '{{partnersUrl}}/help', label: 'Partner help' },
  { href: '{{partnersUrl}}', label: 'Dashboard' },
];

// ── New booking ──────────────────────────────────────────────────────────────
// Variables: customerFirst, customerShort, listingName, heroLabel, heroValue,
// rows[], capacity? {filled,total,pct}, earnings?, ctaUrl, ctaLabel,
// preheader.

export const partnerBookingConfirmed: EmailDesign = {
  key: 'partner.booking_confirmed',
  name: 'Circls · Partner: new booking',
  msg91Slug: 'circls_partner_new_booking',
  subject: 'New booking: {{listingName}} — {{customerShort}}',
  html: emailDocument({
    preheader: '{{preheader}}',
    pill: { tone: 'green', text: 'New registration' },
    headline: '{{customerFirst}} just booked in.',
    intro: `A new booking came through for ${strong('{{listingName}}')}.`,
    card:
      cardHero('{{heroLabel}}', '{{heroValue}}') +
      cardRows() +
      `{{#if capacity}}${cardProgress('capacity')}{{/if}}` +
      `{{#if earnings}}${cardTotal('Your earnings', '{{earnings}}')}{{/if}}`,
    cta: { href: '{{ctaUrl}}', label: '{{ctaLabel}}', color: 'coral' },
    footnote: '{{#if earnings}}Earnings settle in the next payout cycle, after platform fees.{{/if}}',
    signoff: 'go fill those spots',
    footerReason: PARTNER_FOOTER_REASON('you list on Circls'),
    footerLinks: PARTNER_FOOTER_LINKS,
  }),
  text:
    'Hello,\n\n' +
    '{{customerShort}} just booked {{listingName}}.\n\n' +
    '{{heroLabel}}: {{heroValue}}\n' +
    '{{#each rows}}{{label}}: {{value}}\n{{/each}}' +
    '{{#if capacity}}Spots filled: {{capacity.filled}} of {{capacity.total}}\n{{/if}}' +
    '{{#if earnings}}Your earnings: {{earnings}} (settles in the next payout cycle, after platform fees)\n{{/if}}\n' +
    '{{ctaLabel}}: {{ctaUrl}}\n\n— Circls\n',
  sample: {
    preheader: '2 tickets · ₹798 · 18 of 40 spots filled',
    customerFirst: 'Rohan',
    customerShort: 'Rohan M.',
    listingName: 'Sunday 10K Social',
    heroLabel: 'When',
    heroValue: 'Sun 12 Oct, 6:00 AM',
    rows: [
      { label: 'Booked by', value: 'Rohan Mehta' },
      { label: 'Listing', value: 'Sunday 10K Social' },
      { label: 'Quantity', value: '2 × General' },
      { label: 'Booking ref', value: 'BK-3HN7-2RT8', mono: true },
      { label: 'Amount paid', value: '₹798' },
    ],
    capacity: { filled: 18, total: 40, pct: 45 },
    earnings: '₹718',
    ctaUrl: 'https://partners.circls.app/events/0193a2b4-0000-7000-8000-000000055120',
    ctaLabel: 'View registrations',
  },
};

// ── Listing approved ─────────────────────────────────────────────────────────
// Variables: greetingName, listingType, listingName, subjectName, rows[],
// reviewerNote?, liveUrl, preheader.

export const listingApproved: EmailDesign = {
  key: 'listing.approved',
  name: 'Circls · Partner: listing approved',
  msg91Slug: 'circls_partner_listing_approved',
  subject: 'Approved: {{subjectName}} is live',
  html: emailDocument({
    preheader: '{{preheader}}',
    pill: { tone: 'green', text: 'Approved' },
    headline: 'You&rsquo;re live.',
    intro: `Good news, {{greetingName}} &mdash; your {{listingType}} ${strong('{{listingName}}')} passed review and is now visible on Circls.`,
    card: cardHero('Listing', '{{listingName}}') + cardRows(),
    boxes: `{{#if reviewerNote}}${noteBox('lilac', 'Note from the reviewer', '{{reviewerNote}}')}{{/if}}`,
    cta: { href: '{{liveUrl}}', label: 'See your live listing', color: 'coral' },
    footnote: 'Share it around &mdash; the first few bookings help it climb in search.',
    signoff: 'now go fill it up',
    footerReason: PARTNER_FOOTER_REASON('you submitted a listing on Circls'),
    footerLinks: PARTNER_FOOTER_LINKS,
  }),
  text:
    'Good news, {{greetingName}} — your {{listingType}} "{{listingName}}" passed review and is now visible on Circls.\n\n' +
    '{{#each rows}}{{label}}: {{value}}\n{{/each}}\n' +
    '{{#if reviewerNote}}Note from the reviewer: {{reviewerNote}}\n\n{{/if}}' +
    'See your live listing: {{liveUrl}}\n\n— Circls\n',
  sample: {
    preheader: 'Your arena passed review and is now bookable.',
    greetingName: 'Kabir',
    listingType: 'arena',
    listingName: 'Turf 2 · 5-a-side',
    subjectName: 'Bandra Sports Club — Turf 2 · 5-a-side',
    rows: [
      { label: 'Type', value: 'Arena' },
      { label: 'Organizer', value: 'Bandra Sports Club' },
      { label: 'Submitted', value: 'Mon 29 Sep' },
      { label: 'Approved', value: 'Tue 30 Sep' },
      { label: 'Listing ID', value: 'AR-2093-1A7C', mono: true },
    ],
    liveUrl: 'https://circls.app/venues/0193a2b4-0000-7000-8000-000000020931',
  },
};

// ── Listing needs changes (rejected) ─────────────────────────────────────────
// A rejected listing can't be edited back into review, so the next step is to
// list it again with the fixes: events have Duplicate, other types are added
// afresh. Variables: greetingName, listingType, listingName, subjectName,
// rows[], fixes[] (may be empty), ctaUrl, ctaLabel, nextStep, preheader.

export const listingRejected: EmailDesign = {
  key: 'listing.rejected',
  name: 'Circls · Partner: changes needed',
  msg91Slug: 'circls_partner_changes_needed',
  subject: 'Changes needed: {{subjectName}}',
  html: emailDocument({
    preheader: '{{preheader}}',
    pill: { tone: 'orange', text: 'Changes needed' },
    headline: 'Almost there.',
    intro: `Hi {{greetingName}} &mdash; we couldn&rsquo;t approve your {{listingType}} ${strong('{{listingName}}')} just yet. A few quick fixes and it&rsquo;s good to go.`,
    card: cardHero('Listing', '{{listingName}}') + cardRows(),
    boxes: noteBox(
      'orange',
      'What to fix',
      `{{#if fixes}}${bulletList('fixes')}\n<div style="padding-top:10px;color:#4a4654">Everything else looks great!</div>` +
        `{{else}}The reviewer didn&rsquo;t add details. Check the listing against the guidelines in Partner help, or ask us what to change.{{/if}}`,
    ),
    cta: { href: '{{ctaUrl}}', label: '{{ctaLabel}}', color: 'coral' },
    footnote: '{{nextStep}}{{#if canReply}} Questions? Just reply to this email.{{/if}}',
    signoff: 'you&rsquo;re nearly live',
    footerReason: PARTNER_FOOTER_REASON('you submitted a listing on Circls'),
    footerLinks: PARTNER_FOOTER_LINKS,
  }),
  text:
    'Hi {{greetingName}},\n\n' +
    'We couldn’t approve your {{listingType}} "{{listingName}}" just yet.\n\n' +
    '{{#each rows}}{{label}}: {{value}}\n{{/each}}\n' +
    'What to fix:\n{{#if fixes}}{{#each fixes}}- {{this}}\n{{/each}}{{else}}The reviewer didn’t add details. Check the listing guidelines in Partner help.\n{{/if}}\n' +
    '{{nextStep}}\n\n{{ctaLabel}}: {{ctaUrl}}\n\n— Circls\n',
  sample: {
    preheader: '3 quick fixes and your event can go live.',
    greetingName: 'Priya',
    listingType: 'event',
    listingName: 'Sunday 10K Social',
    subjectName: 'Sunday 10K Social',
    rows: [
      { label: 'Type', value: 'Event' },
      { label: 'Organizer', value: 'Sunrise Run Club' },
      { label: 'Submitted', value: 'Mon 29 Sep' },
      { label: 'Reviewed', value: 'Tue 30 Sep' },
      { label: 'Listing ID', value: 'EV-5512-0B3D', mono: true },
    ],
    fixes: [
      'Cover image is under 1200px wide — upload a sharper one.',
      'Add a meeting point so attendees know where to show up.',
      'Refund policy is missing — pick one in Ticketing settings.',
    ],
    ctaUrl: 'https://partners.circls.app/events/new?from=0193a2b4-0000-7000-8000-000000055120',
    ctaLabel: 'Duplicate & resubmit',
    nextStep: 'Duplicate it with the fixes and submit — it’s usually reviewed within 24 hours.',
    canReply: true,
  },
};
