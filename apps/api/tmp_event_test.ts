// One-off: send a sample EVENT booking confirmation. Deleted after use.
process.env['SANDBOX_SMTP_HOST'] = '';
process.env['DATABASE_URL'] ??= 'postgres://placeholder@127.0.0.1:5432/placeholder';

const recipient = process.argv[2];
if (!recipient) throw new Error('usage: tmp_event_test.ts <email>');

const { getEmailProvider } = await import('./src/lib/notifications/email.js');
const { msg91TemplateId } = await import('./src/lib/notifications/email_designs/index.js');

// What notification_payloads.customerConfirmedPayload builds for an event.
const payload = {
  bookingId: '0193a2b4-0000-7000-8000-00003hn72rt8',
  customerName: 'Akshat Saboo',
  when: 'Sun 2 Nov, 6:00 AM',
  itemName: 'Sunday 10K Social',
  details: 'Event: Sunday 10K Social\nWhere: Marine Drive Promenade\nWhen: Sun 2 Nov, 6:00 AM\nTickets: 2 × General\nTotal: ₹798',
  preheader: 'Sunday 10K Social · Sun 2 Nov, 6:00 AM',
  firstName: 'Akshat',
  itemNoun: 'spot',
  placeName: 'Sunday 10K Social',
  shortDate: 'Sun 2 Nov',
  heroLabel: 'When',
  heroValue: 'Sun 2 Nov, 6:00 AM',
  rows: [
    { label: 'Event', value: 'Sunday 10K Social' },
    { label: 'Where', value: 'Marine Drive Promenade' },
    { label: 'Tickets', value: '2 × General' },
    { label: 'Booking ref', value: 'BK-3HN7-2RT8', mono: true },
  ],
  totalLabel: 'Total paid',
  totalValue: '₹798',
  bookingUrl: 'https://circls.app/me/bookings/0193a2b4-0000-7000-8000-00003hn72rt8',
};

const router = getEmailProvider();
console.log(`booking.confirmed (event): ${router.external.mode} via ${msg91TemplateId('booking.confirmed') ?? 'generic template'} -> ${recipient}`);
const r = await router.send({ recipient, templateKey: 'booking.confirmed', payload });
console.log(`accepted, message id: ${r.providerMessageId ?? '(none)'}`);
