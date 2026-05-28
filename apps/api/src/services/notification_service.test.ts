import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  arenas,
  bookings,
  notifications,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyKycStateChange,
} from './notification_service.js';
import { tenantMembers } from '../db/schema/tenant_members.js';
import { __resetNotificationsForTesting } from '../lib/notifications/index.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('notification_service integration', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  let ownerUserId: string;

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
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where id = ${arenaId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${ownerUserId}`);
    await closeDb();
  });

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

  it('notifyKycStateChange emails the tenant owner on verified', async () => {
    await notifyKycStateChange(tenantId, 'verified');

    const rows = await db
      .select()
      .from(notifications)
      .where(
        sql`tenant_id = ${tenantId} and template_key = 'kyc.verified'`,
      );

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect(row.channel).toBe('email');
    // The owner's email matches what we inserted in beforeAll.
    expect(row.recipient).toMatch(/notif-owner-.+@test\.x/);
    expect(row.userId).toBe(ownerUserId);
  });

  it('notifyKycStateChange emails owner with reason on rejected', async () => {
    await notifyKycStateChange(tenantId, 'rejected', {
      rejectionReason: 'PAN does not match',
    });

    const rows = await db
      .select()
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and template_key = 'kyc.rejected'`);

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect(row.channel).toBe('email');
    expect(row.payload).toMatchObject({ reason: 'PAN does not match' });
  });

  it('notifyKycStateChange is a no-op for non-terminal statuses', async () => {
    const before = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and template_key like 'kyc.%'`);
    const beforeCount = Number(before[0]?.count ?? 0);

    await notifyKycStateChange(tenantId, 'in_review');
    await notifyKycStateChange(tenantId, 'submitted');

    const after = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and template_key like 'kyc.%'`);
    const afterCount = Number(after[0]?.count ?? 0);

    expect(afterCount).toBe(beforeCount);
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
});
