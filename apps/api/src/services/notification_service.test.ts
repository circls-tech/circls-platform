import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  arenas,
  bookings,
  events,
  memberships,
  notifications,
  tenants,
  userMemberships,
  users,
  venues,
} from '../db/schema/index.js';
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
} from './notification_service.js';
import { tenantMembers } from '../db/schema/tenant_members.js';
import { __resetNotificationsForTesting } from '../lib/notifications/index.js';
import { renderTemplate, type NotificationChannel } from '../lib/notifications/templates.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/** 20:00 in India, 09:30 in Boston. Far enough ahead that reminders would be due. */
const EVENT_START = new Date('2030-01-15T14:30:00Z');
const EVENT_END = new Date('2030-01-15T16:30:00Z');

describe.skipIf(!runIntegration)('notification_service integration', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  let ownerUserId: string;
  let consumerUserId: string | undefined;
  const extraTenantIds: string[] = [];

  beforeAll(async () => {
    await pingDb();
    __resetNotificationsForTesting();

    const [u] = await db
      .insert(users)
      .values({
        firebaseUid: `notif-fb-${Date.now()}`,
        email: `notif-owner-${Date.now()}@test.x`,
      })
      .returning();
    ownerUserId = u!.id;

    const [t] = await db
      .insert(tenants)
      .values({ name: 'Notif Co', slug: `notif-${Date.now()}` })
      .returning();
    tenantId = t!.id;

    await db.insert(tenantMembers).values({
      userId: ownerUserId,
      tenantId,
      role: 'owner',
    });

    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'Tigers Arena', tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;

    const [a] = await db
      .insert(arenas)
      .values({ venueId, name: 'Court 1' })
      .returning();
    arenaId = a!.id;
  });

  afterAll(async () => {
    for (const id of [tenantId, ...extraTenantIds]) {
      await db.execute(sql`delete from notifications where tenant_id = ${id}`);
      await db.execute(sql`delete from bookings where tenant_id = ${id}`);
      await db.execute(sql`
        delete from user_memberships
         where membership_id in (select id from memberships where tenant_id = ${id})`);
      await db.execute(sql`delete from memberships where tenant_id = ${id}`);
      await db.execute(sql`delete from events where tenant_id = ${id}`);
    }
    await db.execute(sql`
      delete from arenas where venue_id in (select id from venues where tenant_id = ${tenantId})`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    for (const id of [tenantId, ...extraTenantIds]) {
      await db.execute(sql`delete from tenants where id = ${id}`);
    }
    await db.execute(sql`delete from users where id = ${ownerUserId}`);
    // After bookings are gone — a bookings.customer_user_id FK points here.
    if (consumerUserId) {
      await db.execute(sql`delete from users where id = ${consumerUserId}`);
    }
    await closeDb();
  });

  /** Every notification row written for a booking. */
  async function rowsFor(bookingId: string) {
    return db
      .select()
      .from(notifications)
      .where(sql`payload->>'bookingId' = ${bookingId}`);
  }

  /** What the provider sends for one of those rows. */
  async function rendered(bookingId: string, channel: NotificationChannel, templateKey: string) {
    const row = (await rowsFor(bookingId)).find(
      (r) => r.channel === channel && r.templateKey === templateKey,
    );
    expect(row, `${channel}:${templateKey}`).toBeDefined();
    return renderTemplate(channel, templateKey, row!.payload);
  }

  const contact = (n: number) => ({
    customerContact: `+91900000000${n}`,
    customerContactJson: { phone: `+91900000000${n}`, email: `guest${n}@example.com` },
  });

  async function insertVenueEvent(eventVenueId: string, name = 'Sunday Football Meetup') {
    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId: eventVenueId,
        name,
        startsAt: EVENT_START,
        endsAt: EVENT_END,
        status: 'published',
      })
      .returning();
    return ev!;
  }

  it('notifyBookingConfirmed inserts SMS + email rows + scheduled reminders for future booking', async () => {
    // Booking with start time well in the future, both phone + email.
    const startAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // T+7d
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
    const timeRange = `[${startAt.toISOString()},${endAt.toISOString()})`;

    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        slotArenaId: arenaId,
        timeRange,
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'confirmed',
        customerName: 'Asha',
        customerContact: '+919999999999',
        customerContactJson: {
          phone: '+919999999999',
          email: 'asha@example.com',
        },
        totalPaise: 50000,
      })
      .returning();
    const bookingId = b!.id;

    await notifyBookingConfirmed(bookingId);

    const rows = await db
      .select()
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and payload->>'bookingId' = ${bookingId}`);

    // We expect at minimum: SMS confirmed (sent), email confirmed (sent),
    // SMS reminder_t24h (pending+scheduled), SMS reminder_t1h (pending+scheduled).
    expect(rows.length).toBeGreaterThanOrEqual(4);

    const byChannelAndKey = (channel: string, key: string) =>
      rows.filter((r) => r.channel === channel && r.templateKey === key);

    expect(byChannelAndKey('sms', 'booking.confirmed')).toHaveLength(1);
    expect(byChannelAndKey('email', 'booking.confirmed')).toHaveLength(1);
    expect(byChannelAndKey('sms', 'booking.reminder_t24h')).toHaveLength(1);
    expect(byChannelAndKey('sms', 'booking.reminder_t1h')).toHaveLength(1);

    const confirmSms = byChannelAndKey('sms', 'booking.confirmed')[0]!;
    // Stub provider returns success, so the dispatcher marks it sent.
    expect(confirmSms.status).toBe('sent');
    expect(confirmSms.sentAt).toBeTruthy();
    expect(confirmSms.providerMessageId).toMatch(/^stub_sms_/);

    const reminderT24 = byChannelAndKey('sms', 'booking.reminder_t24h')[0]!;
    expect(reminderT24.status).toBe('pending');
    expect(reminderT24.sentAt).toBeNull();
    expect(reminderT24.scheduledFor).toBeTruthy();
    // Reminder should be ~24h before startAt — within 2 minutes' tolerance.
    const t24Diff = Math.abs(
      new Date(reminderT24.scheduledFor!).getTime() -
        (startAt.getTime() - 24 * 60 * 60 * 1000),
    );
    expect(t24Diff).toBeLessThan(2 * 60 * 1000);

    // The slot copy reads as it always has: arena in brackets, an INR total.
    expect(confirmSms.payload).toMatchObject({
      itemType: 'slot',
      venueName: 'Tigers Arena',
      arenaName: 'Court 1',
      total: 'Rs 500.00',
    });
    expect(renderTemplate('sms', 'booking.confirmed', confirmSms.payload).body).toMatch(
      /^Circls: Your booking at Tigers Arena \(Court 1\) for \d{2} [A-Z][a-z]{2,3} \d{4}, \d{2}:\d{2} is confirmed\. Ref [0-9a-f-]{36}\.$/,
    );
    expect((await rendered(bookingId, 'email', 'booking.confirmed')).body).toContain(
      'Arena: Court 1\n',
    );
  });

  it('slot booking at a US venue: venue-local time and a dollar total', async () => {
    const [harbor] = await db
      .insert(venues)
      .values({ tenantId, name: 'Harbor Courts', tzName: 'America/New_York' })
      .returning();
    const [court] = await db
      .insert(arenas)
      .values({ venueId: harbor!.id, name: 'Court A' })
      .returning();
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId: harbor!.id,
        itemType: 'slot',
        slotArenaId: court!.id,
        timeRange: `[${EVENT_START.toISOString()},${EVENT_END.toISOString()})`,
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Lee',
        ...contact(8),
        totalPaise: 4000,
        currency: 'USD',
      })
      .returning();

    await notifyBookingConfirmed(b!.id);

    expect((await rendered(b!.id, 'sms', 'booking.confirmed')).body).toBe(
      `Circls: Your booking at Harbor Courts (Court A) for 15 Jan 2030, 09:30 is confirmed. Ref ${b!.id}.`,
    );
    expect((await rendered(b!.id, 'email', 'booking.confirmed')).body).toContain('Total: $40.00\n');
  });

  it('notifyBookingCancelled inserts SMS + email rows, no reminders', async () => {
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        slotArenaId: arenaId,
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'cancelled',
        customerName: 'Cancel-Me',
        customerContact: '+918888888888',
        customerContactJson: {
          phone: '+918888888888',
          email: 'cm@example.com',
        },
        totalPaise: 50000,
      })
      .returning();
    const bookingId = b!.id;

    await notifyBookingCancelled(bookingId);

    const rows = await db
      .select()
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and payload->>'bookingId' = ${bookingId}`);

    expect(rows).toHaveLength(2);
    const tplKeys = rows.map((r) => `${r.channel}:${r.templateKey}`).sort();
    expect(tplKeys).toEqual(['email:booking.cancelled', 'sms:booking.cancelled']);
  });

  it('notifyBookingConfirmed falls back to the customer user profile for phone + email', async () => {
    // Consumer-style booking: only the phone in customer_contact, no
    // customer_contact_json — the email must come from the users row.
    const [consumer] = await db
      .insert(users)
      .values({
        firebaseUid: `notif-consumer-${Date.now()}`,
        phoneE164: '+917777777777',
        email: `consumer-${Date.now()}@test.x`,
        displayName: 'Profile Person',
      })
      .returning();
    consumerUserId = consumer!.id;

    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        slotArenaId: arenaId,
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerUserId: consumer!.id,
        customerName: 'Profile Person',
        customerContact: '+917777777777',
        totalPaise: 50000,
      })
      .returning();
    const bookingId = b!.id;

    await notifyBookingConfirmed(bookingId);

    const rows = await db
      .select()
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and payload->>'bookingId' = ${bookingId}`);

    const confirmKeys = rows
      .filter((r) => r.templateKey === 'booking.confirmed')
      .map((r) => `${r.channel}`)
      .sort();
    expect(confirmKeys).toEqual(['email', 'sms']);
    const emailRow = rows.find((r) => r.channel === 'email')!;
    expect(emailRow.recipient).toBe(consumer!.email);
  });

  it('notifyBookingConfirmed without contacts is a silent no-op (no rows for that booking)', async () => {
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        slotArenaId: arenaId,
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'confirmed',
        // No customer contact at all.
        customerName: 'Anonymous',
        totalPaise: 0,
      })
      .returning();
    const bookingId = b!.id;

    await notifyBookingConfirmed(bookingId);

    const rows = await db
      .select()
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and payload->>'bookingId' = ${bookingId}`);

    expect(rows).toHaveLength(0);
  });

  it('event booking: names the event and its start, and schedules no reminders', async () => {
    const ev = await insertVenueEvent(venueId);
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Ravi',
        ...contact(1),
        totalPaise: 20000,
        currency: 'INR',
        itemData: { eventId: ev.id, eventName: ev.name },
      })
      .returning();
    const bookingId = b!.id;

    await notifyBookingConfirmed(bookingId);

    // The event starts in 2030, yet only the confirmation goes out.
    const keys = (await rowsFor(bookingId)).map((r) => `${r.channel}:${r.templateKey}`).sort();
    expect(keys).toEqual(['email:booking.confirmed', 'sms:booking.confirmed']);

    expect((await rendered(bookingId, 'sms', 'booking.confirmed')).body).toBe(
      'Circls: Your booking for Sunday Football Meetup at Tigers Arena on 15 Jan 2030, 20:00 ' +
        `is confirmed. Ref ${bookingId}.`,
    );
    const email = await rendered(bookingId, 'email', 'booking.confirmed');
    expect(email.subject).toBe('Booking confirmed — Sunday Football Meetup');
    expect(email.body).toContain(
      'Event: Sunday Football Meetup\nWhere: Tigers Arena\nWhen: 15 Jan 2030, 20:00\nTotal: Rs 200.00\n',
    );
    expect(email.body).not.toContain('Arena:');
  });

  it('standalone US event: organiser as the place, event-local time, a dollar total', async () => {
    const [us] = await db
      .insert(tenants)
      .values({ name: 'Harbor Hoops Co', slug: `notif-us-${Date.now()}` })
      .returning();
    extraTenantIds.push(us!.id);
    const [ev] = await db
      .insert(events)
      .values({
        tenantId: us!.id,
        venueId: null,
        addressJson: { line1: '100 Legends Way', city: 'Boston', country: 'USA' },
        tzName: 'America/New_York',
        name: 'Boston Pickup Basketball',
        startsAt: EVENT_START,
        endsAt: EVENT_END,
        status: 'published',
      })
      .returning();
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId: us!.id,
        venueId: null,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Sam',
        ...contact(2),
        totalPaise: 2500,
        currency: 'USD',
        itemData: { eventId: ev!.id, eventName: ev!.name },
      })
      .returning();
    const bookingId = b!.id;

    await notifyBookingConfirmed(bookingId);

    expect((await rendered(bookingId, 'sms', 'booking.confirmed')).body).toBe(
      'Circls: Your booking for Boston Pickup Basketball at Harbor Hoops Co on 15 Jan 2030, 09:30 ' +
        `is confirmed. Ref ${bookingId}.`,
    );
    const email = (await rendered(bookingId, 'email', 'booking.confirmed')).body;
    expect(email).toContain('Total: $25.00\n');
    expect(email).not.toContain('Rs ');
  });

  it("event re-scoped after booking: the event's venue now, not the booking's snapshot", async () => {
    const [hall] = await db
      .insert(venues)
      .values({ tenantId, name: 'Crimson Hall', tzName: 'Asia/Kolkata' })
      .returning();
    const ev = await insertVenueEvent(hall!.id, 'Moved Meetup');
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId, // where the event was when this ticket sold
        itemType: 'event',
        channel: 'circls',
        paymentMethod: 'free',
        status: 'confirmed',
        customerName: 'Mo',
        ...contact(3),
        totalPaise: 0,
        itemData: { eventId: ev.id, eventName: ev.name },
      })
      .returning();

    await notifyBookingConfirmed(b!.id);

    expect((await rendered(b!.id, 'sms', 'booking.confirmed')).body).toContain(
      'for Moved Meetup at Crimson Hall on 15 Jan 2030, 20:00',
    );
  });

  it('an event timezone Intl does not know falls back to IST instead of throwing', async () => {
    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId: null,
        addressJson: { city: 'Bengaluru' },
        tzName: 'Not/AZone',
        name: 'Odd Zone Run',
        startsAt: EVENT_START,
        endsAt: EVENT_END,
        status: 'published',
      })
      .returning();
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: 'free',
        status: 'confirmed',
        customerName: 'Zed',
        ...contact(4),
        totalPaise: 0,
        itemData: { eventId: ev!.id, eventName: ev!.name },
      })
      .returning();

    await expect(notifyBookingConfirmed(b!.id)).resolves.toBeUndefined();

    expect((await rendered(b!.id, 'sms', 'booking.confirmed')).body).toContain(
      'for Odd Zone Run at Notif Co on 15 Jan 2030, 20:00',
    );
  });

  it('membership booking: names the plan and when it runs out', async () => {
    const [m] = await db
      .insert(memberships)
      .values({ tenantId, venueId, name: 'Tigers Club', durationDays: 30 })
      .returning();
    const [um] = await db
      .insert(userMemberships)
      .values({
        membershipId: m!.id,
        externalName: 'Priya',
        startsAt: new Date('2030-01-15T12:00:00Z'),
        endsAt: new Date('2030-02-14T12:00:00Z'),
      })
      .returning();
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'membership',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Priya',
        ...contact(5),
        totalPaise: 99900,
        itemData: { membershipId: m!.id, userMembershipId: um!.id },
      })
      .returning();
    const bookingId = b!.id;

    await notifyBookingConfirmed(bookingId);

    const keys = (await rowsFor(bookingId)).map((r) => `${r.channel}:${r.templateKey}`).sort();
    expect(keys).toEqual(['email:booking.confirmed', 'sms:booking.confirmed']);
    expect((await rendered(bookingId, 'sms', 'booking.confirmed')).body).toBe(
      'Circls: Your membership Tigers Club at Tigers Arena is confirmed, valid until 14 Feb 2030. ' +
        `Ref ${bookingId}.`,
    );
    const email = (await rendered(bookingId, 'email', 'booking.confirmed')).body;
    expect(email).toContain('Membership: Tigers Club\nWhere: Tigers Arena\nValid until: 14 Feb 2030\n');
    expect(email).toContain('Total: Rs 999.00\n');
  });

  it('a registration the partner recorded (external, zero total) states no total', async () => {
    const ev = await insertVenueEvent(venueId, 'Door Sales Night');
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'event',
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'confirmed',
        customerName: 'Walk-in',
        ...contact(6),
        totalPaise: 0,
        itemData: { eventId: ev.id, eventName: ev.name },
      })
      .returning();

    await notifyBookingConfirmed(b!.id);

    const email = (await rendered(b!.id, 'email', 'booking.confirmed')).body;
    expect(email).toContain('Event: Door Sales Night\n');
    expect(email).not.toContain('Total');
  });

  it('notifyBookingCancelled names the event for an event booking', async () => {
    const ev = await insertVenueEvent(venueId, 'Called-Off Cup');
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'cancelled',
        customerName: 'Dev',
        ...contact(7),
        totalPaise: 20000,
        itemData: { eventId: ev.id, eventName: ev.name },
      })
      .returning();

    await notifyBookingCancelled(b!.id);

    expect((await rendered(b!.id, 'sms', 'booking.cancelled')).body).toBe(
      'Circls: Your booking for Called-Off Cup at Tigers Arena on 15 Jan 2030, 20:00 ' +
        `has been cancelled. Ref ${b!.id}.`,
    );
  });
});
