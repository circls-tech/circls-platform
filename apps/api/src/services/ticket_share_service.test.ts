/**
 * Share booking: a customer hands individual QR tickets to friends through
 * links. Integration (RUN_INTEGRATION + DB).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, events, memberships, qrTickets, tenants, users, venues } from '../db/schema/index.js';
import { getMyBookingDetail, listMyBookings } from './consumer_service.js';
import {
  claimTicketShare,
  previewTicketShare,
  shareTicket,
  withdrawTicketShare,
} from './ticket_share_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const DAY = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await closeDb();
});

describe.skipIf(!runIntegration)('share booking (ticket shares)', () => {
  const tag = `tshare-${Date.now()}`;
  let tenantId: string;
  let venueId: string;
  let eventId: string;
  let pastEventId: string;
  let asha: string; // the customer
  let priya: string; // a friend
  let ravi: string; // another friend
  let bookingId: string;
  let tickets: string[];
  let pastBookingId: string;
  let pastTicket: string;
  let membershipBookingId: string;
  let membershipTicket: string;

  async function ticketsFor(booking: string, n: number, itemType: 'event' | 'membership' = 'event') {
    const rows = await db
      .insert(qrTickets)
      .values(
        Array.from({ length: n }, (_, i) => ({
          tenantId,
          bookingId: booking,
          itemType,
          label: `General · ${i + 1} of ${n}`,
          code: `${tag}-${booking}-${i}`,
        })),
      )
      .returning({ id: qrTickets.id });
    return rows.map((r) => r.id);
  }

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: 'TShare', slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db.insert(venues).values({ tenantId, name: `TShare Arena ${tag}`, status: 'active' }).returning();
    venueId = v!.id;
    const [ua] = await db.insert(users).values({ firebaseUid: `${tag}-a`, displayName: 'Asha Rao' }).returning({ id: users.id });
    const [ub] = await db.insert(users).values({ firebaseUid: `${tag}-b`, displayName: 'Priya Shah' }).returning({ id: users.id });
    const [uc] = await db.insert(users).values({ firebaseUid: `${tag}-c`, displayName: 'Ravi' }).returning({ id: users.id });
    asha = ua!.id;
    priya = ub!.id;
    ravi = uc!.id;

    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Sunday Smash',
        startsAt: new Date(Date.now() + DAY),
        endsAt: new Date(Date.now() + DAY + 2 * 60 * 60 * 1000),
        pricePaise: 50000,
        status: 'published',
      })
      .returning({ id: events.id });
    eventId = ev!.id;
    const [pe] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Last Week Smash',
        startsAt: new Date(Date.now() - 7 * DAY),
        endsAt: new Date(Date.now() - 7 * DAY + 60 * 60 * 1000),
        pricePaise: 50000,
        status: 'published',
      })
      .returning({ id: events.id });
    pastEventId = pe!.id;

    const eventBooking = (eid: string) => ({
      tenantId,
      venueId,
      itemType: 'event' as const,
      channel: 'circls' as const,
      paymentMethod: 'razorpay_route' as const,
      status: 'confirmed' as const,
      totalPaise: 150000,
      note: 'Window seats please',
      customerName: 'Asha Rao',
      customerContact: '+919800000001',
      itemData: { eventId: eid },
      createdByUserId: asha,
      customerUserId: asha,
    });
    const [b] = await db.insert(bookings).values(eventBooking(eventId)).returning({ id: bookings.id });
    bookingId = b!.id;
    tickets = await ticketsFor(bookingId, 3);
    const [pb] = await db.insert(bookings).values(eventBooking(pastEventId)).returning({ id: bookings.id });
    pastBookingId = pb!.id;
    pastTicket = (await ticketsFor(pastBookingId, 1))[0]!;

    const [m] = await db
      .insert(memberships)
      .values({ tenantId, name: 'Gold Plan', durationDays: 30, pricePaise: 100000, status: 'active' })
      .returning({ id: memberships.id });
    const [mb] = await db
      .insert(bookings)
      .values({
        tenantId,
        itemType: 'membership',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 100000,
        itemData: { membershipId: m!.id },
        createdByUserId: asha,
        customerUserId: asha,
      })
      .returning({ id: bookings.id });
    membershipBookingId = mb!.id;
    membershipTicket = (await ticketsFor(membershipBookingId, 1, 'membership'))[0]!;
  });

  afterAll(async () => {
    await db.execute(sql`delete from booking_ticket_shares where booking_id in (select id from bookings where tenant_id = ${tenantId})`);
    await db.execute(sql`delete from qr_tickets where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from memberships where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from users where id in (${asha}, ${priya}, ${ravi})`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  });

  it('the customer can share their booking, and sharing a ticket again returns the same link', async () => {
    const before = await getMyBookingDetail(asha, bookingId);
    expect(before.canShare).toBe(true);
    expect(before.sharedBy).toBeNull();

    const { token } = await shareTicket(asha, bookingId, tickets[0]!);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await shareTicket(asha, bookingId, tickets[0]!)).token).toBe(token);

    const detail = await getMyBookingDetail(asha, bookingId);
    expect(detail.qrTickets.find((t) => t.id === tickets[0])!.share).toEqual({ state: 'pending', token, acceptedBy: null });
    expect(detail.qrTickets.find((t) => t.id === tickets[1])!.share).toBeNull();
  });

  it('a friend sees what the link is, accepts it, and gets the booking with only their ticket', async () => {
    const { token } = await shareTicket(asha, bookingId, tickets[0]!);
    const preview = await previewTicketShare(priya, token);
    expect(preview).toMatchObject({
      state: 'available',
      bookingId: null,
      sharedBy: 'Asha',
      itemType: 'event',
      title: 'Sunday Smash',
      place: `TShare Arena ${tag}`,
      ticketLabel: 'General · 1 of 3',
    });

    expect(await claimTicketShare(priya, token)).toEqual({ bookingId });
    // Accepting again is harmless.
    expect(await claimTicketShare(priya, token)).toEqual({ bookingId });
    expect((await previewTicketShare(priya, token)).state).toBe('yours');

    const row = (await listMyBookings(priya)).find((b) => b.id === bookingId)!;
    expect(row).toMatchObject({ sharedBy: 'Asha', totalPaise: 0, venueName: `TShare Arena ${tag}` });

    const d = await getMyBookingDetail(priya, bookingId);
    expect(d.sharedBy).toBe('Asha');
    expect(d.canShare).toBe(false);
    expect(d.qrTickets.map((t) => t.id)).toEqual([tickets[0]]);
    expect(d.qrTickets[0]!.share).toBeNull();
    // The customer's price, payment, contact and note stay theirs.
    expect(d).toMatchObject({ totalPaise: 0, paymentMethod: '', note: null, customerName: null, customerContact: null });
    expect(d.event?.answers).toEqual([]);

    const own = await getMyBookingDetail(asha, bookingId);
    expect(own.qrTickets.find((t) => t.id === tickets[0])!.share).toEqual({ state: 'accepted', token: null, acceptedBy: 'Priya' });
    expect(own.totalPaise).toBe(150000);
  });

  it('an accepted ticket is final: nobody else can take it and it cannot be withdrawn', async () => {
    const { token } = await shareTicket(asha, bookingId, tickets[0]!).catch(() => ({ token: '' }));
    expect(token).toBe('');
    await expect(shareTicket(asha, bookingId, tickets[0]!)).rejects.toMatchObject({ code: 'ticket_already_shared' });
    await expect(withdrawTicketShare(asha, bookingId, tickets[0]!)).rejects.toMatchObject({ code: 'ticket_share_accepted' });

    const priyaLink = (await db.execute<{ token: string }>(
      sql`select token from booking_ticket_shares where qr_ticket_id = ${tickets[0]!}::uuid and withdrawn_at is null`,
    )) as unknown as { token: string }[];
    expect((await previewTicketShare(ravi, priyaLink[0]!.token)).state).toBe('taken');
    await expect(claimTicketShare(ravi, priyaLink[0]!.token)).rejects.toMatchObject({ code: 'ticket_share_taken' });
  });

  it('the customer can’t accept their own link, and a friend can’t share or see the rest', async () => {
    const { token } = await shareTicket(asha, bookingId, tickets[1]!);
    expect((await previewTicketShare(asha, token)).state).toBe('own');
    await expect(claimTicketShare(asha, token)).rejects.toMatchObject({ code: 'own_ticket' });
    await expect(shareTicket(priya, bookingId, tickets[2]!)).rejects.toMatchObject({ code: 'ticket_not_found' });
    await expect(getMyBookingDetail(ravi, bookingId)).rejects.toMatchObject({ code: 'booking_not_found' });
  });

  it('a link nobody accepted can be withdrawn, and then leads nowhere', async () => {
    const { token } = await shareTicket(asha, bookingId, tickets[2]!);
    await withdrawTicketShare(asha, bookingId, tickets[2]!);
    expect((await previewTicketShare(ravi, token)).state).toBe('withdrawn');
    await expect(claimTicketShare(ravi, token)).rejects.toMatchObject({ code: 'ticket_share_withdrawn' });
    await expect(withdrawTicketShare(asha, bookingId, tickets[2]!)).rejects.toMatchObject({ code: 'ticket_share_not_found' });
    // A fresh link can be made for it.
    const again = await shareTicket(asha, bookingId, tickets[2]!);
    expect(again.token).not.toBe(token);
  });

  it('memberships, finished bookings and cancelled bookings can’t be shared', async () => {
    await expect(shareTicket(asha, membershipBookingId, membershipTicket)).rejects.toMatchObject({ code: 'booking_not_shareable' });
    await expect(shareTicket(asha, pastBookingId, pastTicket)).rejects.toMatchObject({ code: 'booking_not_shareable' });
    expect((await getMyBookingDetail(asha, pastBookingId)).canShare).toBe(false);

    const { token } = await shareTicket(asha, bookingId, tickets[1]!);
    await db.execute(sql`update bookings set status = 'cancelled' where id = ${bookingId}::uuid`);
    try {
      expect((await previewTicketShare(ravi, token)).state).toBe('inactive');
      await expect(claimTicketShare(ravi, token)).rejects.toMatchObject({ code: 'booking_not_shareable' });
      await expect(shareTicket(asha, bookingId, tickets[1]!)).rejects.toMatchObject({ code: 'booking_not_shareable' });
      expect((await getMyBookingDetail(asha, bookingId)).canShare).toBe(false);
    } finally {
      await db.execute(sql`update bookings set status = 'confirmed' where id = ${bookingId}::uuid`);
    }
  });

  it('an unknown link is not found', async () => {
    await expect(previewTicketShare(priya, 'nope-not-a-real-token-at-all')).rejects.toMatchObject({
      code: 'ticket_share_not_found',
    });
  });
});
