import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { eventTicketTiers, events, tenants, users, venues } from '../db/schema/index.js';
import type { PostBookingRedirect } from '../db/schema/post_booking_redirect.js';
import { bookEvent } from './booking_service.js';
import { getMyBookingDetail } from './consumer_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/**
 * Delivery of an event's post-booking redirect: it reaches the person who
 * booked (on the book response and on their booking page) and nobody else —
 * the public listing omits it (covered in consumer_events.test.ts) and an
 * unconfirmed booking doesn't carry it either.
 */
describe.skipIf(!runIntegration)('post-booking redirect delivery', () => {
  let tenantId: string;
  let venueId: string;
  let userId: string;

  const REDIRECT: PostBookingRedirect = {
    url: 'https://forms.gle/squad-roster',
    description: 'Send us your roster',
    forced: true,
  };

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `pbr-fb-${Date.now()}`, email: `pbr-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Pbr Co', slug: `pbrco-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'PbrV', tzName: 'Asia/Kolkata', status: 'active' })
      .returning();
    venueId = v!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from qr_tickets where tenant_id = ${tenantId}`);
    await db.execute(
      sql`delete from event_booking_tickets where booking_id in (select id from bookings where tenant_id = ${tenantId})`,
    );
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from event_ticket_tiers where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${userId}`);
    await closeDb();
  });

  /** A published, free event (+1 tier) carrying the given redirect. */
  async function makeEvent(postBookingRedirect: PostBookingRedirect | null) {
    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Redirect Event',
        startsAt: new Date('2032-06-01T10:00:00Z'),
        endsAt: new Date('2032-06-01T14:00:00Z'),
        status: 'published',
        postBookingRedirect,
      })
      .returning();
    const [tier] = await db
      .insert(eventTicketTiers)
      .values({ eventId: ev!.id, tenantId, name: 'General', pricePaise: 0 })
      .returning();
    return { event: ev!, tier: tier! };
  }

  it('hands the redirect back with a confirmed booking', async () => {
    const { event, tier } = await makeEvent(REDIRECT);
    const res = await bookEvent(event.id, { userId, name: 'Roster Filler' }, null, [
      { tierId: tier.id, quantity: 1 },
    ]);
    expect(res.booking.status).toBe('confirmed');
    expect(res.postBookingRedirect).toEqual(REDIRECT);
  });

  it('keeps it on the booking page so the customer can return to it', async () => {
    const { event, tier } = await makeEvent(REDIRECT);
    const res = await bookEvent(event.id, { userId }, null, [{ tierId: tier.id, quantity: 1 }]);

    const detail = await getMyBookingDetail(userId, res.booking.id);
    expect(detail.event?.postBookingRedirect).toEqual(REDIRECT);
  });

  it('withholds it while the booking is unconfirmed', async () => {
    const { event, tier } = await makeEvent(REDIRECT);
    const res = await bookEvent(event.id, { userId }, null, [{ tierId: tier.id, quantity: 1 }]);
    // Stand in for an abandoned paid checkout: the booking exists but has not
    // been paid for, so the link isn't earned yet.
    await db.execute(sql`update bookings set status = 'pending' where id = ${res.booking.id}`);

    const detail = await getMyBookingDetail(userId, res.booking.id);
    expect(detail.event?.postBookingRedirect).toBeNull();
  });

  it('is null when the organiser set no link', async () => {
    const { event, tier } = await makeEvent(null);
    const res = await bookEvent(event.id, { userId }, null, [{ tierId: tier.id, quantity: 1 }]);

    expect(res.postBookingRedirect).toBeNull();
    const detail = await getMyBookingDetail(userId, res.booking.id);
    expect(detail.event?.postBookingRedirect).toBeNull();
  });
});
