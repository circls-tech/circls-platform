import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  arenas,
  eventTicketTiers,
  events,
  memberships,
  qrTickets,
  slots,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import { bookEvent, prepareOnlineBookingWithPayment } from './booking_service.js';
import { cancelPaidBooking } from './cancellation_service.js';
import { cancelEvent } from './events_service.js';
import { purchaseMembership } from './memberships_service.js';
import {
  issueQrTicketsForBooking,
  qrTicketDataUrl,
  revokeQrTicketsForBooking,
  validateQrTicket,
} from './qr_ticket_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/**
 * QR tickets end-to-end at the service layer: issuance on the free/inline
 * confirm paths (paid paths reuse the same issuance call from the capture
 * webhook), the per-item ticket shapes, and the door-scan state machine.
 */
describe.skipIf(!runIntegration)('qr_ticket_service', () => {
  let tenantId: string;
  let otherTenantId: string;
  let venueId: string;
  let userId: string;

  const QR_ON = {
    enabled: true,
    multiUse: false,
    maxScans: null,
    validFromOffsetMin: null,
    validUntilOffsetMin: null,
  };

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `qr-fb-${Date.now()}`, email: `qr-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;

    const [t] = await db
      .insert(tenants)
      .values({ name: 'Qr Co', slug: `qrco-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [t2] = await db
      .insert(tenants)
      .values({ name: 'Other Co', slug: `qrother-${Date.now()}`, status: 'active' })
      .returning();
    otherTenantId = t2!.id;

    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'QrV', tzName: 'Asia/Kolkata', status: 'active' })
      .returning();
    venueId = v!.id;
  });

  afterAll(async () => {
    for (const tid of [tenantId, otherTenantId]) {
      await db.execute(sql`delete from qr_tickets where tenant_id = ${tid}`);
      await db.execute(sql`delete from notifications where tenant_id = ${tid}`);
      await db.execute(sql`delete from payments where tenant_id = ${tid}`);
      await db.execute(sql`delete from audit_log where tenant_id = ${tid}`);
      await db.execute(
        sql`delete from event_booking_tickets where booking_id in (select id from bookings where tenant_id = ${tid})`,
      );
      await db.execute(
        sql`delete from user_memberships where membership_id in (select id from memberships where tenant_id = ${tid})`,
      );
      await db.execute(sql`update slots set booking_id = null where tenant_id = ${tid}`);
      await db.execute(sql`delete from bookings where tenant_id = ${tid}`);
      await db.execute(sql`delete from slots where tenant_id = ${tid}`);
      await db.execute(sql`delete from event_ticket_tiers where tenant_id = ${tid}`);
      await db.execute(sql`delete from events where tenant_id = ${tid}`);
      await db.execute(sql`delete from memberships where tenant_id = ${tid}`);
    }
    await db.execute(sql`delete from arenas where venue_id = ${venueId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${otherTenantId}`);
    await db.execute(sql`delete from users where id = ${userId}`);
    await closeDb();
  });

  /** Insert a published event (+1 free tier) with the given QR config. */
  async function makeEvent(
    qrTicketConfig: Record<string, unknown> | null,
    window?: { startsAt: Date; endsAt: Date },
  ) {
    const startsAt = window?.startsAt ?? new Date('2032-06-01T10:00:00Z');
    const endsAt = window?.endsAt ?? new Date('2032-06-01T14:00:00Z');
    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Qr Event',
        startsAt,
        endsAt,
        status: 'published',
        qrTicketConfig: qrTicketConfig as never,
      })
      .returning();
    const [tier] = await db
      .insert(eventTicketTiers)
      .values({ eventId: ev!.id, tenantId, name: 'General', pricePaise: 0 })
      .returning();
    return { event: ev!, tier: tier! };
  }

  it('mints one ticket per seat for a free event booking, with frozen rules', async () => {
    const { event, tier } = await makeEvent({ ...QR_ON, validFromOffsetMin: 120 });
    const res = await bookEvent(event.id, { userId, name: 'Seat Buyer' }, null, [
      { tierId: tier.id, quantity: 3 },
    ]);
    expect(res.booking.status).toBe('confirmed');

    const issued = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${res.booking.id}`)
      .orderBy(qrTickets.label);
    expect(issued).toHaveLength(3);
    expect(issued.map((t) => t.label)).toEqual([
      'General · 1 of 3',
      'General · 2 of 3',
      'General · 3 of 3',
    ]);
    // validFrom = startsAt − 120min; validUntil = endsAt (no offset).
    expect(issued[0]!.validFrom?.toISOString()).toBe('2032-06-01T08:00:00.000Z');
    expect(issued[0]!.validUntil?.toISOString()).toBe('2032-06-01T14:00:00.000Z');
    expect(issued[0]!.multiUse).toBe(false);
    expect(qrTicketDataUrl(issued[0]!.code)).toContain(`/check-in?code=${issued[0]!.code}`);

    // Idempotent: a replay of the confirm hook mints nothing new.
    const again = await issueQrTicketsForBooking(res.booking.id);
    expect(again).toHaveLength(3);
  });

  it('mints nothing when the event has QR tickets disabled', async () => {
    const { event, tier } = await makeEvent(null);
    const res = await bookEvent(event.id, { userId }, null, [{ tierId: tier.id, quantity: 1 }]);
    const issued = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${res.booking.id}`);
    expect(issued).toHaveLength(0);
  });

  it('a not-yet-open window scans as not_yet_valid; expired windows as expired', async () => {
    // Far-future event: window opens 60min before start.
    const future = await makeEvent({ ...QR_ON, validFromOffsetMin: 60 });
    const fRes = await bookEvent(future.event.id, { userId }, null, [
      { tierId: future.tier.id, quantity: 1 },
    ]);
    const [fTicket] = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${fRes.booking.id}`);
    const fScan = await validateQrTicket({ tenantId, actorUserId: userId }, fTicket!.code);
    expect(fScan.outcome).toBe('not_yet_valid');

    // Past event: window closed 30min after it ended, back in 2020.
    const past = await makeEvent(
      { ...QR_ON, validUntilOffsetMin: 30 },
      { startsAt: new Date('2020-01-01T10:00:00Z'), endsAt: new Date('2020-01-01T12:00:00Z') },
    );
    const pRes = await bookEvent(past.event.id, { userId }, null, [
      { tierId: past.tier.id, quantity: 1 },
    ]);
    const [pTicket] = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${pRes.booking.id}`);
    const pScan = await validateQrTicket({ tenantId, actorUserId: userId }, pTicket!.code);
    expect(pScan.outcome).toBe('expired');
  });

  it('single-use: first scan valid (flips to used), replay is already_used; peek does not consume', async () => {
    const { event, tier } = await makeEvent(QR_ON);
    const res = await bookEvent(event.id, { userId, name: 'Door Person' }, null, [
      { tierId: tier.id, quantity: 1 },
    ]);
    const [ticket] = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${res.booking.id}`);
    const ctx = { tenantId, actorUserId: userId };

    // Peek first: no scan spent.
    const peek = await validateQrTicket(ctx, ticket!.code, { consume: false });
    expect(peek.outcome).toBe('valid');
    expect(peek.ticket?.scanCount).toBe(0);
    expect(peek.ticket?.status).toBe('active');

    const first = await validateQrTicket(ctx, ticket!.code);
    expect(first.outcome).toBe('valid');
    expect(first.ticket?.scanCount).toBe(1);
    expect(first.ticket?.status).toBe('used');
    expect(first.ticket?.customerName).toBe('Door Person');

    const replay = await validateQrTicket(ctx, ticket!.code);
    expect(replay.outcome).toBe('already_used');

    // Cross-tenant probe reads as not_found.
    const foreign = await validateQrTicket(
      { tenantId: otherTenantId, actorUserId: userId },
      ticket!.code,
    );
    expect(foreign.outcome).toBe('not_found');
    expect(await validateQrTicket(ctx, 'no-such-code')).toMatchObject({ outcome: 'not_found' });
  });

  it('multi-use honours the scan cap', async () => {
    const { event, tier } = await makeEvent({ ...QR_ON, multiUse: true, maxScans: 2 });
    const res = await bookEvent(event.id, { userId }, null, [{ tierId: tier.id, quantity: 1 }]);
    const [ticket] = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${res.booking.id}`);
    const ctx = { tenantId, actorUserId: userId };

    const s1 = await validateQrTicket(ctx, ticket!.code);
    expect(s1).toMatchObject({ outcome: 'valid', ticket: { scanCount: 1, status: 'active' } });
    const s2 = await validateQrTicket(ctx, ticket!.code);
    expect(s2).toMatchObject({ outcome: 'valid', ticket: { scanCount: 2, status: 'used' } });
    const s3 = await validateQrTicket(ctx, ticket!.code);
    expect(s3.outcome).toBe('already_used');
  });

  it('slot bookings mint one ticket per arena, spanning that arena\'s slots', async () => {
    const [aOn] = await db
      .insert(arenas)
      .values({ venueId, name: 'Qr Court', qrTicketConfig: QR_ON as never })
      .returning();
    const [aOff] = await db
      .insert(arenas)
      .values({ venueId, name: 'Plain Court' })
      .returning();

    // Two free slots on the QR arena (one booking) + one on the plain arena
    // (a second booking) — bookings are single-arena on this branch.
    const mkSlot = (arenaId: string, fromIso: string, toIso: string) =>
      db.execute<{ id: string }>(sql`
        insert into slots (tenant_id, arena_id, time_range, price_paise, status)
        values (${tenantId}::uuid, ${arenaId}::uuid,
          tstzrange(${fromIso}::timestamptz, ${toIso}::timestamptz, '[)'), 0, 'open')
        returning id`);
    const [s1] = await mkSlot(aOn!.id, '2032-07-01T05:00:00Z', '2032-07-01T05:30:00Z');
    const [s2] = await mkSlot(aOn!.id, '2032-07-01T05:30:00Z', '2032-07-01T06:00:00Z');
    const [s3] = await mkSlot(aOff!.id, '2032-07-01T05:00:00Z', '2032-07-01T05:30:00Z');

    const ctx = { tenantId, actorUserId: userId };
    const onRes = await prepareOnlineBookingWithPayment(ctx, venueId, {
      slotIds: [(s1 as { id: string }).id, (s2 as { id: string }).id],
      customerName: 'Slot Buyer',
      customerContact: '+15555550111',
    });
    const offRes = await prepareOnlineBookingWithPayment(ctx, venueId, {
      slotIds: [(s3 as { id: string }).id],
      customerName: 'Slot Buyer',
      customerContact: '+15555550111',
    });

    // QR-enabled arena: one ticket spanning both booked slots.
    const issued = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${onRes.bookingId}`);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.label).toBe('Qr Court');
    expect(issued[0]!.itemType).toBe('slot');
    expect(issued[0]!.validUntil?.toISOString()).toBe('2032-07-01T06:00:00.000Z');

    // Plain arena: nothing minted.
    const plain = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${offRes.bookingId}`);
    expect(plain).toHaveLength(0);

    // Revoking (cancellation hook) blocks the door.
    await revokeQrTicketsForBooking(onRes.bookingId);
    const scan = await validateQrTicket(ctx, issued[0]!.code);
    expect(scan.outcome).toBe('revoked');
  });

  it('free membership purchases mint a membership pass keyed on the user_membership', async () => {
    const [m] = await db
      .insert(memberships)
      .values({
        tenantId,
        name: 'Qr Club',
        pricePaise: 0,
        durationDays: 30,
        status: 'active',
        qrTicketConfig: { ...QR_ON, multiUse: true, maxScans: null } as never,
      })
      .returning();

    const res = await purchaseMembership({ membershipId: m!.id, userId });
    const issued = await db
      .select()
      .from(qrTickets)
      .where(sql`user_membership_id = ${res.userMembershipId}`);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.itemType).toBe('membership');
    expect(issued[0]!.label).toBe('Qr Club');
    expect(issued[0]!.bookingId).toBeNull();
    expect(issued[0]!.multiUse).toBe(true);
    expect(issued[0]!.maxScans).toBeNull();
    // Window = the membership period (validUntil ≈ startsAt + 30d).
    expect(issued[0]!.validUntil).not.toBeNull();

    // A membership pass scans repeatedly without exhausting.
    const ctx = { tenantId, actorUserId: userId };
    for (let i = 1; i <= 3; i++) {
      const scan = await validateQrTicket(ctx, issued[0]!.code);
      expect(scan).toMatchObject({ outcome: 'valid', ticket: { scanCount: i, status: 'active' } });
    }
  });

  it('cancelling a booking via cancelPaidBooking revokes its QR ticket (not just the direct revoke helper)', async () => {
    const [arena] = await db
      .insert(arenas)
      .values({ venueId, name: 'Qr Cancel Court', qrTicketConfig: QR_ON as never })
      .returning();
    const [slotRow] = await db.execute<{ id: string }>(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status)
      values (${tenantId}::uuid, ${arena!.id}::uuid,
        tstzrange('2032-08-01T05:00:00Z'::timestamptz, '2032-08-01T05:30:00Z'::timestamptz, '[)'), 0, 'open')
      returning id`);

    const ctx = { tenantId, actorUserId: userId };
    const res = await prepareOnlineBookingWithPayment(ctx, venueId, {
      slotIds: [(slotRow as { id: string }).id],
      customerName: 'Cancel Buyer',
      customerContact: '+15555550112',
    });

    const [issued] = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${res.bookingId}`);
    expect(issued).toBeDefined();
    expect((await validateQrTicket(ctx, issued!.code, { consume: false })).outcome).toBe('valid');

    await cancelPaidBooking({
      bookingId: res.bookingId,
      actorUserId: userId,
      reason: 'test cancellation',
      bySelf: true,
    });

    const scan = await validateQrTicket(ctx, issued!.code, { consume: false });
    expect(scan.outcome).toBe('revoked');
  });

  it('cancelling an event via cancelEvent revokes QR tickets already issued for its bookings', async () => {
    const { event, tier } = await makeEvent(QR_ON);
    const res = await bookEvent(event.id, { userId }, null, [{ tierId: tier.id, quantity: 1 }]);
    const [issued] = await db
      .select()
      .from(qrTickets)
      .where(sql`booking_id = ${res.booking.id}`);
    expect(issued).toBeDefined();

    const ctx = { tenantId, actorUserId: userId };
    await cancelEvent(ctx, event.id);

    const scan = await validateQrTicket(ctx, issued!.code, { consume: false });
    expect(scan.outcome).toBe('revoked');
  });
});
