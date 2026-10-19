import { describe, expect, it } from 'vitest';
import {
  __templateChannelsForTesting,
  renderTemplate,
  templateSupportsChannel,
  type NotificationChannel,
} from './templates.js';

describe('renderTemplate (pure)', () => {
  it('renders booking.confirmed SMS with substitutions', () => {
    const out = renderTemplate('sms', 'booking.confirmed', {
      venueName: 'Tigers Arena',
      arenaName: 'Court 1',
      when: '04 Jul 2026, 18:00',
      total: 'Rs 500.00',
      bookingId: 'abc-123',
    });
    expect(out.subject).toBeUndefined();
    expect(out.body).toContain('Tigers Arena');
    expect(out.body).toContain('Court 1');
    expect(out.body).toContain('04 Jul 2026, 18:00');
    expect(out.body).toContain('abc-123');
    // SMS template should not contain unresolved {{ markers
    expect(out.body).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('renders booking.confirmed email with subject + body', () => {
    const out = renderTemplate('email', 'booking.confirmed', {
      customerName: 'Asha',
      venueName: 'Tigers Arena',
      arenaName: 'Court 1',
      when: '04 Jul 2026, 18:00',
      total: 'Rs 500.00',
      bookingId: 'abc-123',
    });
    expect(out.subject).toBe('Booking confirmed — Tigers Arena');
    expect(out.body).toContain('Hi Asha,');
    expect(out.body).toContain('Rs 500.00');
    expect(out.body).toContain('abc-123');
  });

  it('substitutes missing vars with empty string', () => {
    const out = renderTemplate('sms', 'otp.login', { code: '' });
    // Should NOT keep the literal {{code}} — render should produce an empty hole.
    expect(out.body).not.toContain('{{');
    expect(out.body).toContain('Your Circls login code is');
  });

  it('throws on unknown template key', () => {
    expect(() => renderTemplate('sms', 'does.not.exist', {})).toThrow(/unknown_template/);
  });

  it('throws when the channel is not supported for that key', () => {
    // otp.login is sms-only; asking for email should throw.
    expect(() => renderTemplate('email', 'otp.login', { code: '123456' })).toThrow(
      /channel_not_supported/,
    );
  });

  it('templateSupportsChannel reflects the matrix', () => {
    expect(templateSupportsChannel('sms', 'booking.confirmed')).toBe(true);
    expect(templateSupportsChannel('whatsapp', 'booking.confirmed')).toBe(true);
    expect(templateSupportsChannel('email', 'booking.confirmed')).toBe(true);
    expect(templateSupportsChannel('whatsapp', 'booking.cancelled')).toBe(false);
    expect(templateSupportsChannel('email', 'otp.login')).toBe(false);
    expect(templateSupportsChannel('sms', 'kyc.verified')).toBe(false);
  });
});

// Payloads as notification_service builds them.
const slot = {
  itemType: 'slot',
  bookingId: 'abc-123',
  customerName: 'Asha',
  venueName: 'Tigers Arena',
  arenaName: 'Court 1',
  eventTitle: null,
  membershipName: null,
  when: '04 Jul 2026, 18:00',
  validUntil: null,
  total: 'Rs 500.00',
};
const event = {
  ...slot,
  itemType: 'event',
  bookingId: 'bk-1',
  venueName: 'Crimson Sports Hub',
  arenaName: '',
  eventTitle: 'Sunday Football Meetup',
  when: '07 Oct 2026, 07:00',
  total: 'Rs 200.00',
};
const membership = {
  ...slot,
  itemType: 'membership',
  bookingId: 'bk-2',
  venueName: 'Crimson Sports Hub',
  arenaName: '',
  membershipName: 'Crimson Club Membership',
  when: 'your booked time',
  validUntil: '30 Oct 2026',
  total: 'Rs 999.00',
};

describe('booking copy per item type', () => {
  it('renders slot bookings exactly as before', () => {
    expect(renderTemplate('sms', 'booking.confirmed', slot).body).toBe(
      'Circls: Your booking at Tigers Arena (Court 1) for 04 Jul 2026, 18:00 is confirmed. Ref abc-123.',
    );
    expect(renderTemplate('email', 'booking.confirmed', slot)).toEqual({
      subject: 'Booking confirmed — Tigers Arena',
      body:
        'Hi Asha,\n\nYour booking is confirmed.\n\n' +
        'Venue: Tigers Arena\nArena: Court 1\nWhen: 04 Jul 2026, 18:00\nTotal: Rs 500.00\n' +
        'Booking ref: abc-123\n\nSee you there!\n— Circls',
    });
    expect(renderTemplate('whatsapp', 'booking.confirmed', slot).body).toBe(
      'Booking confirmed at *Tigers Arena* (Court 1) for 04 Jul 2026, 18:00. Ref: abc-123.',
    );
    expect(renderTemplate('sms', 'booking.cancelled', slot).body).toBe(
      'Circls: Your booking at Tigers Arena on 04 Jul 2026, 18:00 has been cancelled. Ref abc-123.',
    );
    expect(renderTemplate('sms', 'booking.reminder_t24h', slot).body).toBe(
      'Circls reminder: You have a booking tomorrow at Tigers Arena (Court 1) — 04 Jul 2026, 18:00.',
    );
    expect(renderTemplate('whatsapp', 'booking.reminder_t1h', slot).body).toBe(
      'Starting in 1 hour: *Tigers Arena* (Court 1) — 04 Jul 2026, 18:00.',
    );
  });

  it('drops the arena clause and the Arena: line when there is no arena', () => {
    for (const arenaName of ['', '  ', null, undefined]) {
      const p = { ...slot, arenaName };
      expect(renderTemplate('sms', 'booking.confirmed', p).body).toBe(
        'Circls: Your booking at Tigers Arena for 04 Jul 2026, 18:00 is confirmed. Ref abc-123.',
      );
      expect(renderTemplate('email', 'booking.confirmed', p).body).not.toContain('Arena:');
      expect(renderTemplate('whatsapp', 'booking.reminder_t24h', p).body).toBe(
        'Reminder: Your booking at *Tigers Arena* is tomorrow — 04 Jul 2026, 18:00.',
      );
    }
  });

  it('renders a reminder queued before itemType existed with the slot copy', () => {
    // The payload shape notification_service wrote before variants.
    const legacy = {
      bookingId: 'abc-123',
      customerName: 'Asha',
      venueName: 'Tigers Arena',
      arenaName: 'Court 1',
      when: '04 Jul 2026, 18:00',
      totalRupees: '500.00',
    };
    expect(renderTemplate('sms', 'booking.reminder_t1h', legacy).body).toBe(
      'Circls reminder: Your booking at Tigers Arena (Court 1) starts in an hour — 04 Jul 2026, 18:00.',
    );
  });

  it('names the event and its start for event bookings', () => {
    expect(renderTemplate('sms', 'booking.confirmed', event).body).toBe(
      'Circls: Your booking for Sunday Football Meetup at Crimson Sports Hub on 07 Oct 2026, 07:00 ' +
        'is confirmed. Ref bk-1.',
    );
    expect(renderTemplate('email', 'booking.confirmed', event)).toEqual({
      subject: 'Booking confirmed — Sunday Football Meetup',
      body:
        'Hi Asha,\n\nYour booking for Sunday Football Meetup is confirmed.\n\n' +
        'Event: Sunday Football Meetup\nWhere: Crimson Sports Hub\nWhen: 07 Oct 2026, 07:00\n' +
        'Total: Rs 200.00\nBooking ref: bk-1\n\nSee you there!\n— Circls',
    });
    expect(renderTemplate('whatsapp', 'booking.confirmed', event).body).toBe(
      'Booking confirmed for *Sunday Football Meetup* at Crimson Sports Hub on 07 Oct 2026, 07:00. ' +
        'Ref: bk-1.',
    );
    expect(renderTemplate('sms', 'booking.cancelled', event).body).toBe(
      'Circls: Your booking for Sunday Football Meetup at Crimson Sports Hub on 07 Oct 2026, 07:00 ' +
        'has been cancelled. Ref bk-1.',
    );
    expect(renderTemplate('email', 'booking.cancelled', event).subject).toBe(
      'Booking cancelled — Sunday Football Meetup',
    );
  });

  it('names the plan and how long it runs for membership bookings', () => {
    expect(renderTemplate('sms', 'booking.confirmed', membership).body).toBe(
      'Circls: Your membership Crimson Club Membership at Crimson Sports Hub is confirmed, ' +
        'valid until 30 Oct 2026. Ref bk-2.',
    );
    expect(renderTemplate('email', 'booking.confirmed', membership)).toEqual({
      subject: 'Membership confirmed — Crimson Sports Hub',
      body:
        'Hi Asha,\n\nYour membership is confirmed.\n\n' +
        'Membership: Crimson Club Membership\nWhere: Crimson Sports Hub\nValid until: 30 Oct 2026\n' +
        'Total: Rs 999.00\nBooking ref: bk-2\n\nSee you there!\n— Circls',
    });
    expect(renderTemplate('whatsapp', 'booking.confirmed', membership).body).toBe(
      'Membership confirmed: *Crimson Club Membership* at Crimson Sports Hub, valid until 30 Oct 2026. ' +
        'Ref: bk-2.',
    );
    expect(renderTemplate('sms', 'booking.cancelled', membership).body).toBe(
      'Circls: Your membership Crimson Club Membership at Crimson Sports Hub has been cancelled. Ref bk-2.',
    );
  });

  it('leaves out the plan and date when a membership could not be loaded', () => {
    const bare = { ...membership, membershipName: null, validUntil: null };
    expect(renderTemplate('sms', 'booking.confirmed', bare).body).toBe(
      'Circls: Your membership at Crimson Sports Hub is confirmed. Ref bk-2.',
    );
    expect(renderTemplate('whatsapp', 'booking.confirmed', bare).body).toBe(
      'Membership confirmed at Crimson Sports Hub. Ref: bk-2.',
    );
    const email = renderTemplate('email', 'booking.confirmed', bare).body;
    expect(email).not.toContain('Membership:');
    expect(email).not.toContain('Valid until:');
  });

  it('prints the total in whatever currency it comes in, and omits it when absent', () => {
    const usd = renderTemplate('email', 'booking.confirmed', { ...event, total: '$25.00' }).body;
    expect(usd).toContain('Total: $25.00\n');
    expect(usd).not.toContain('Rs');

    const none = renderTemplate('email', 'booking.confirmed', { ...event, total: null }).body;
    expect(none).not.toContain('Total');
  });

  it('falls back to the base copy for an item type without a variant', () => {
    for (const itemType of ['slot', 'constructor', 'unknown']) {
      expect(renderTemplate('sms', 'booking.confirmed', { ...slot, itemType }).body).toBe(
        'Circls: Your booking at Tigers Arena (Court 1) for 04 Jul 2026, 18:00 is confirmed. Ref abc-123.',
      );
    }
  });

  it('never renders an empty clause, label or placeholder', () => {
    const payloads = [
      slot,
      { ...slot, arenaName: '' },
      event,
      { ...event, total: null },
      membership,
      { ...membership, membershipName: null, validUntil: null, total: null },
    ];
    const keys = ['booking.confirmed', 'booking.cancelled', 'booking.reminder_t24h', 'booking.reminder_t1h'];
    const channels: NotificationChannel[] = ['sms', 'email', 'whatsapp'];
    for (const key of keys) {
      for (const channel of channels.filter((c) => templateSupportsChannel(c, key))) {
        for (const payload of payloads) {
          const { subject, body } = renderTemplate(channel, key, payload);
          for (const text of [subject ?? '', body]) {
            const where = `${key}/${channel}/${payload.itemType}: ${text}`;
            expect(text, where).not.toMatch(/\(\s*\)/);
            expect(text, where).not.toMatch(/\{\{|\}\}/);
            expect(text, where).not.toMatch(/ {2}| [.,]/);
            // A "Label:" line with nothing after it.
            expect(text, where).not.toMatch(/^[A-Za-z][A-Za-z ]*:\s*$/m);
          }
        }
      }
    }
  });

  it('gives every variant the same channels as its base copy', () => {
    const matrix = __templateChannelsForTesting();
    const variants = matrix.filter((m) => m.variant !== null);
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      const base = matrix.find((m) => m.templateKey === v.templateKey && m.variant === null);
      expect(v.channels, `${v.templateKey}/${v.variant}`).toEqual(base?.channels);
    }
  });
});
