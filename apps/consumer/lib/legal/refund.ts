import type { LegalDoc } from './types';

export const REFUND: LegalDoc = {
  slug: 'refund',
  title: 'Return & Refund Policy',
  updated: '12 May 2026',
  intro:
    'All ticket purchases, event registrations, or paid services made through circls.app are subject to the refund policy set by the respective event organizer. Circls, operated by Gibbous Technologies Private Limited, acts as a platform facilitator and does not independently guarantee refunds unless explicitly stated.',
  sections: [
    {
      group: 'Refund Eligibility',
      number: 1,
      title: 'General Refund Policy',
      paragraphs: [
        'Refund eligibility depends on the policies set by the event organizer for each specific event. Unless an organizer explicitly states otherwise, the default rules below apply.',
      ],
      bullets: [
        'Non-refundable: Event tickets once booked',
        'Non-refundable: Platform / convenience fees',
        'Non-refundable: No-shows & late arrivals',
        'Potentially eligible: Event cancelled by organizer',
        'Potentially eligible: Event rescheduled (within window)',
        'Potentially eligible: Duplicate / double charge',
      ],
    },
    {
      number: 2,
      title: 'Eligible Refund Scenarios',
      paragraphs: [
        'a. Event Cancellation — If an event is cancelled by the organizer, users may be eligible for a full refund of the ticket amount, or a credit for future events, as determined by the organizer.',
        'b. Event Rescheduling — If an event is rescheduled, users may choose to attend the new date or request a refund within the specified window provided by the organizer. Partial refunds may be offered at the organizer\'s discretion.',
        'c. Duplicate Transactions — If a user is charged multiple times for the same booking, the excess amount will be refunded in full after verification by our support team.',
      ],
    },
    {
      group: 'Timelines & Process',
      number: 3,
      title: 'Refund Request Timeline',
      paragraphs: [
        'All refund requests must be raised within the windows below. Requests made beyond these periods may not be considered.',
      ],
      bullets: [
        '48 hrs — After event cancellation announcement',
        '48 hrs — After detection of payment issues',
        '7–10 — Business days to process approved refunds',
        'Approved refunds will be credited to the original payment method unless stated otherwise.',
      ],
    },
    {
      number: 4,
      title: 'How to Request a Refund',
      paragraphs: [
        'Refund requests must be submitted via the Circls platform or through our designated support channel. Please include your booking reference, event name, and reason for the request.',
      ],
    },
    {
      group: 'Special Cases',
      number: 5,
      title: 'Organizer-Specific Policies',
      paragraphs: [
        'Some events may have customized refund rules — including partial refunds, deadline-based refunds, or stricter no-refund policies. Users are advised to review the event-specific refund terms before booking, as organizer policies take precedence over the defaults above.',
      ],
    },
    {
      number: 6,
      title: 'Force Majeure',
      paragraphs: [
        'Refunds may not be applicable in situations beyond our control, including but not limited to:',
      ],
      bullets: [
        'Natural disasters.',
        'Government restrictions or orders.',
        'Public safety concerns or pandemics.',
      ],
    },
    {
      number: 7,
      title: 'Disputes',
      paragraphs: [
        'In case of disputes regarding refunds, Gibbous Technologies Private Limited and Circls reserve the right to make the final decision based on available information and platform policies. All disputes are subject to the exclusive jurisdiction of courts in Nagpur, Maharashtra, India.',
      ],
    },
  ],
};
