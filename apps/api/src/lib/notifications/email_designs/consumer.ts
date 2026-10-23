/**
 * Customer emails: booking confirmed, booking cancelled, refund issued.
 * Sent by MSG91 from its stored copy of each template (`msg91Slug`).
 */
import {
  cardHero,
  cardRows,
  cardTotal,
  emailDocument,
  inlineLink,
  noteBox,
  strong,
} from './layout.js';
import type { EmailDesign } from './types.js';

const FOOTER_HELP = { href: '{{consumerUrl}}/help', label: 'Help centre' };

// ── Booking confirmed ────────────────────────────────────────────────────────
// Variables: firstName, itemNoun ("slot" | "spot" | "membership"), placeName,
// heroLabel, heroValue, rows[{label,value,mono?}], totalLabel, totalValue,
// bookingUrl, shortDate, preheader.

export const bookingConfirmed: EmailDesign = {
  key: 'booking.confirmed',
  name: 'Circls · Booking confirmed v2',
  msg91Slug: 'circls_booking_confirmed_v2',
  subject: 'You’re booked in — {{placeName}}, {{shortDate}}',
  html: emailDocument({
    preheader: '{{preheader}}',
    pill: { tone: 'lilac', text: 'Booking confirmed' },
    headline: 'You&rsquo;re booked in.',
    intro: `Hi {{firstName}} &mdash; your {{itemNoun}} at ${strong('{{placeName}}')} is locked in. Here are the details.`,
    card: cardHero('{{heroLabel}}', '{{heroValue}}') + cardRows() + cardTotal('{{totalLabel}}', '{{totalValue}}'),
    cta: { href: '{{bookingUrl}}', label: 'View your booking', color: 'blue' },
    footnote: 'Need to reschedule or cancel? Do it from the same page.',
    signoff: 'see you there',
    footerReason: 'You&rsquo;re getting this because you booked on Circls.',
    footerLinks: [FOOTER_HELP, { href: '{{bookingUrl}}', label: 'Manage booking' }],
  }),
  text:
    'Hi {{firstName}},\n\n' +
    'Your {{itemNoun}} at {{placeName}} is locked in.\n\n' +
    '{{heroLabel}}: {{heroValue}}\n' +
    '{{#each rows}}{{label}}: {{value}}\n{{/each}}' +
    '{{totalLabel}}: {{totalValue}}\n\n' +
    'View or manage your booking: {{bookingUrl}}\n\n' +
    'See you there!\n— Circls\n',
  sample: {
    preheader: 'Turf 2 · 5-a-side · Sat 4 Oct, 7:00–8:00 PM',
    firstName: 'Ananya',
    itemNoun: 'slot',
    placeName: 'Bandra Sports Club',
    shortDate: 'Sat 4 Oct',
    heroLabel: 'When',
    heroValue: 'Sat 4 Oct, 7:00–8:00 PM',
    rows: [
      { label: 'Venue', value: 'Bandra Sports Club' },
      { label: 'Arena', value: 'Turf 2 · 5-a-side' },
      { label: 'Booking ref', value: 'BK-8F2K-9QD4', mono: true },
    ],
    totalLabel: 'Total paid',
    totalValue: '₹1,200',
    bookingUrl: 'https://circls.app/me/bookings/0193a2b4-0000-7000-8000-00008f2k9qd4',
  },
};

// ── Booking cancelled ────────────────────────────────────────────────────────
// One template for every cancellation. Exactly one of the three mode flags
// drives the copy:
//   eventCancelled — the organizer (or Circls) cancelled the whole event;
//   byCustomer     — the customer cancelled their own booking;
//   (neither)      — the venue/organizer cancelled this booking.
// Variables: firstName, orgName, placeName, subjectName, shortDate, heroValue,
// rows[], refundText? (a refund was issued with the cancellation),
// refundAtVenue? (that refund is cash at the venue), organizerRefundPending?
// (paid, event cancelled, no refund issued yet), organizerNote?, browseUrl,
// bookingUrl, preheader.

const cancelledIntro =
  `{{#if eventCancelled}}Hi {{firstName}} &mdash; ${strong('{{orgName}}')} has cancelled ${strong('{{placeName}}')}. We&rsquo;re sorry &mdash; we know you&rsquo;d planned for it.` +
  `{{else}}{{#if byCustomer}}Hi {{firstName}} &mdash; as you asked, your booking at ${strong('{{placeName}}')} is cancelled.` +
  `{{else}}Hi {{firstName}} &mdash; ${strong('{{orgName}}')} has cancelled your booking at ${strong('{{placeName}}')}. We&rsquo;re sorry for the change of plans.{{/if}}{{/if}}`;

const refundBoxes =
  `{{#if organizerNote}}${noteBox('yellow', 'Note from the organizer', '{{organizerNote}}')}{{/if}}\n` +
  `{{#if refundText}}{{#if refundAtVenue}}` +
  noteBox('green', 'Your refund', `${strong('{{refundText}}')} will be returned to you at the venue.`) +
  `{{else}}` +
  noteBox(
    'green',
    'Your refund is on its way',
    `We&rsquo;ve started a refund of ${strong('{{refundText}}')} to your original payment method. It usually lands in ${strong('5–7 business days')}. No action needed.`,
  ) +
  `{{/if}}{{else}}{{#if organizerRefundPending}}` +
  noteBox(
    'yellow',
    'About your refund',
    `Refunds for a cancelled event are issued by ${strong('{{orgName}}')}. We&rsquo;ll email you the moment yours is on its way.`,
  ) +
  `{{/if}}{{/if}}`;

export const bookingCancelled: EmailDesign = {
  key: 'booking.cancelled',
  name: 'Circls · Booking cancelled v2',
  msg91Slug: 'circls_booking_cancelled_v2',
  subject: 'Cancelled: {{subjectName}} — {{shortDate}}',
  html: emailDocument({
    preheader: '{{preheader}}',
    pill: { tone: 'orange', text: '{{#if eventCancelled}}Event cancelled{{else}}Booking cancelled{{/if}}' },
    headline: '{{#if eventCancelled}}This one&rsquo;s been called off.{{else}}Your booking&rsquo;s cancelled.{{/if}}',
    intro: cancelledIntro,
    card:
      cardHero('Was scheduled for', '{{heroValue}}') +
      cardRows() +
      `{{#if refundText}}${cardTotal('Refund due', '{{refundText}}')}{{/if}}`,
    boxes: refundBoxes,
    cta: { href: '{{browseUrl}}', label: 'Find something else', color: 'blue' },
    footnote: `{{#if refundText}}Track your refund anytime from ${inlineLink('{{bookingUrl}}', 'your bookings')}.{{else}}See this booking anytime in ${inlineLink('{{bookingUrl}}', 'your bookings')}.{{/if}}`,
    signoff: 'plenty more circles out there',
    footerReason: 'You&rsquo;re getting this because you had a booking on Circls.',
    footerLinks: [FOOTER_HELP, { href: '{{bookingUrl}}', label: 'Your bookings' }],
  }),
  text:
    'Hi {{firstName}},\n\n' +
    '{{#if eventCancelled}}{{orgName}} has cancelled {{placeName}}. We’re sorry — we know you’d planned for it.' +
    '{{else}}{{#if byCustomer}}As you asked, your booking at {{placeName}} is cancelled.' +
    '{{else}}{{orgName}} has cancelled your booking at {{placeName}}.{{/if}}{{/if}}\n\n' +
    'Was scheduled for: {{heroValue}}\n' +
    '{{#each rows}}{{label}}: {{value}}\n{{/each}}\n' +
    '{{#if organizerNote}}Note from the organizer: {{organizerNote}}\n\n{{/if}}' +
    '{{#if refundText}}{{#if refundAtVenue}}Your refund of {{refundText}} will be returned to you at the venue.' +
    '{{else}}We’ve started a refund of {{refundText}} to your original payment method. It usually lands in 5–7 business days.{{/if}}\n\n' +
    '{{else}}{{#if organizerRefundPending}}Refunds for a cancelled event are issued by {{orgName}}. We’ll email you the moment yours is on its way.\n\n{{/if}}{{/if}}' +
    'Your bookings: {{bookingUrl}}\n\n— Circls\n',
  sample: {
    preheader: 'Sunday 10K Social on Sun 12 Oct is off. We’ll email you about your refund.',
    eventCancelled: true,
    firstName: 'Ananya',
    orgName: 'Sunrise Run Club',
    placeName: 'Sunday 10K Social',
    subjectName: 'Sunday 10K Social',
    shortDate: 'Sun 12 Oct',
    heroValue: 'Sun 12 Oct, 6:00 AM',
    rows: [
      { label: 'Event', value: 'Sunday 10K Social' },
      { label: 'Where', value: 'Marine Drive Promenade' },
      { label: 'Tickets', value: '2 × General' },
      { label: 'Booking ref', value: 'BK-3HN7-2RT8', mono: true },
    ],
    organizerRefundPending: true,
    browseUrl: 'https://circls.app/events',
    bookingUrl: 'https://circls.app/me/bookings/0193a2b4-0000-7000-8000-00003hn72rt8',
  },
};

// ── Refund issued ────────────────────────────────────────────────────────────
// Variables: firstName, placeName, amountText, paidText, bookingRef, rows[]
// (original booking, reason, refunded to, refund ref, dates), partialNote?,
// expectedBy?, refundUrl, preheader.

export const bookingRefunded: EmailDesign = {
  key: 'booking.refunded',
  name: 'Circls · Refund initiated v2',
  msg91Slug: 'circls_refund_initiated_v2',
  subject: 'Refund of {{amountText}} initiated — {{bookingRef}}',
  html: emailDocument({
    preheader: '{{preheader}}',
    pill: { tone: 'green', text: 'Refund initiated' },
    headline: 'Your refund is on its way.',
    intro: `Hi {{firstName}} &mdash; we&rsquo;ve sent ${strong('{{amountText}}')} back for your booking at ${strong('{{placeName}}')}.`,
    card: cardHero('Refund amount', '{{amountText}}') + cardRows() + cardTotal('Amount paid', '{{paidText}}'),
    boxes: `{{#if partialNote}}${noteBox('yellow', 'Partial refund', '{{partialNote}}')}{{/if}}`,
    cta: { href: '{{refundUrl}}', label: 'View refund status', color: 'blue' },
    footnote: `{{#if expectedBy}}Not showing up after {{expectedBy}}? Share the refund ref with your bank, or ${inlineLink('{{consumerUrl}}/help', 'reach us here')}.{{else}}Questions about this refund? ${inlineLink('{{consumerUrl}}/help', 'Reach us here')}.{{/if}}`,
    signoff: 'until next time',
    footerReason: 'You&rsquo;re getting this because a refund was issued on your Circls booking.',
    footerLinks: [FOOTER_HELP, { href: '{{refundUrl}}', label: 'Refund status' }],
  }),
  text:
    'Hi {{firstName}},\n\n' +
    'We’ve sent {{amountText}} back for your booking at {{placeName}}.\n\n' +
    'Refund amount: {{amountText}}\n' +
    '{{#each rows}}{{label}}: {{value}}\n{{/each}}' +
    'Amount paid: {{paidText}}\n\n' +
    '{{#if partialNote}}Partial refund: {{partialNote}}\n\n{{/if}}' +
    '{{#if expectedBy}}Not showing up after {{expectedBy}}? Share the refund ref with your bank, or reach us at {{consumerUrl}}/help\n\n{{/if}}' +
    'Refund status: {{refundUrl}}\n\n— Circls\n',
  sample: {
    preheader: '₹600 back to your original payment method by Fri 10 Oct.',
    firstName: 'Ananya',
    placeName: 'Bandra Sports Club',
    amountText: '₹600',
    paidText: '₹1,200',
    bookingRef: 'BK-8F2K-9QD4',
    rows: [
      { label: 'Original booking', value: 'BK-8F2K-9QD4', mono: true },
      { label: 'Reason', value: 'Cancelled by you' },
      { label: 'Refunded to', value: 'Original payment method' },
      { label: 'Refund ref', value: 'RF-71KQ-0PZ3', mono: true },
      { label: 'Initiated on', value: 'Fri 3 Oct' },
      { label: 'Expected by', value: 'Fri 10 Oct' },
    ],
    partialNote: 'You’ve been refunded ₹600 of the ₹1,200 you paid, per the venue’s cancellation policy.',
    expectedBy: 'Fri 10 Oct',
    refundUrl: 'https://circls.app/me/bookings/0193a2b4-0000-7000-8000-00008f2k9qd4',
  },
};
