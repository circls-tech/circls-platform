import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  bookings,
  eventBookingTickets,
  eventTicketTiers,
  events,
  notifications,
  tenants,
  venues,
} from '../db/schema/index.js';
import { __resetNotificationsForTesting } from '../lib/notifications/index.js';
import { formatWhen } from '../lib/notifications/email_format.js';
import { notifyBookingConfirmed } from './notification_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/**
 * An event booking holds no arena slots: its confirmation must take the time,
 * name and tickets from the event itself (it used to say "your booked time"
 * with an empty Arena line).
 */
describe.skipIf(!runIntegration)('event booking confirmation (integration)', () => {
  let tenantId: string;
  let venueId: string;
  let eventId: string;
  // A week ahead, so the reminders are still in the future.
  const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const expectedWhen = formatWhen(startsAt, null, 'Asia/Kolkata');

  beforeAll(async () => {
    await pingDb();
    __resetNotificationsForTesting();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Tan Coffee Co', slug: `tan-coffee-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'Tan Coffee', tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;
    const [e] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Coffee Tasting',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
        status: 'published',
      })
      .returning();
    eventId = e!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from event_booking_tickets where booking_id in (select id from bookings where tenant_id = ${tenantId})`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from event_ticket_tiers where event_id = ${eventId}`);
    await db.execute(sql`delete from events where id = ${eventId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('shows the event’s name, place, time and tickets — and no Arena line', async () => {
    const [tier] = await db
      .insert(eventTicketTiers)
      .values({ eventId, tenantId, name: 'General', pricePaise: 0 })
      .returning();
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'event',
        itemData: { eventId, eventName: 'Coffee Tasting' },
        channel: 'circls',
        paymentMethod: 'free',
        status: 'confirmed',
        customerName: 'Shivam Singh',
        customerContactJson: { phone: '+919999900002', email: 'shivam@example.com' },
        totalPaise: 0,
      })
      .returning();
    await db.insert(eventBookingTickets).values({ bookingId: b!.id, tierId: tier!.id, quantity: 2, unitPricePaise: 0 });

    await notifyBookingConfirmed(b!.id);

    const rows = await db
      .select()
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and payload->>'bookingId' = ${b!.id}`);
    const email = rows.find((r) => r.channel === 'email' && r.templateKey === 'booking.confirmed');
    expect(email).toBeDefined();
    expect(email!.payload).toMatchObject({
      itemName: 'Coffee Tasting',
      when: expectedWhen,
      details: `Event: Coffee Tasting\nWhere: Tan Coffee\nWhen: ${expectedWhen}\nTickets: 2 × General\nTotal: Free`,
    });
    // …and what the designed email shows: the event, its time, no Arena row.
    expect(email!.payload).toMatchObject({
      placeName: 'Coffee Tasting',
      itemNoun: 'spot',
      heroValue: expectedWhen,
      totalValue: 'Free',
    });
    const rowLabels = (email!.payload['rows'] as Array<{ label: string; value: string }>).map((r) => r.label);
    expect(rowLabels).toEqual(['Event', 'Where', 'Tickets', 'Booking ref']);
    expect(email!.payload['rows']).toContainEqual({ label: 'Tickets', value: '2 × General' });

    // The event's own start time now drives the SMS reminders too.
    const reminders = rows.filter((r) => r.templateKey.startsWith('booking.reminder_'));
    expect(reminders.length).toBeGreaterThan(0);
  });
});
