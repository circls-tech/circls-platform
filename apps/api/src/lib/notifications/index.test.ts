import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../../db/client.js';
import { notifications, tenants } from '../../db/schema/index.js';
import { __resetNotificationsForTesting, getNotifications } from './index.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('notifications dispatcher integration', () => {
  let tenantId: string;

  beforeAll(async () => {
    await pingDb();
    __resetNotificationsForTesting();

    const [t] = await db
      .insert(tenants)
      .values({ name: 'NotifLib', slug: `notif-lib-${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('dispatch with no scheduledFor sends immediately (via stub) and marks sent', async () => {
    const res = await getNotifications().dispatch({
      tenantId,
      channel: 'sms',
      recipient: '+919999999999',
      templateKey: 'otp.login',
      payload: { code: '123456' },
    });

    expect(res.status).toBe('sent');
    expect(res.providerMessageId).toMatch(/^stub_sms_/);

    const [row] = await db
      .select()
      .from(notifications)
      .where(sql`id = ${res.notificationId}`);
    expect(row?.status).toBe('sent');
    expect(row?.sentAt).toBeTruthy();
  });

  it('dispatch with future scheduledFor leaves the row pending and does NOT send', async () => {
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000); // T+1h
    const res = await getNotifications().dispatch({
      tenantId,
      channel: 'sms',
      recipient: '+919999999998',
      templateKey: 'booking.reminder_t1h',
      payload: { venueName: 'V', arenaName: 'A', when: 'later' },
      scheduledFor,
    });

    expect(res.status).toBe('pending');
    expect(res.providerMessageId).toBeUndefined();

    const [row] = await db
      .select()
      .from(notifications)
      .where(sql`id = ${res.notificationId}`);
    expect(row?.status).toBe('pending');
    expect(row?.sentAt).toBeNull();
    expect(row?.scheduledFor).toBeTruthy();
  });

  it('processPending picks up due rows and skips future-scheduled ones', async () => {
    // Seed two rows: one due now (no scheduledFor) and one scheduled in the future.
    const [dueRow] = await db
      .insert(notifications)
      .values({
        tenantId,
        channel: 'sms',
        recipient: '+919999999997',
        templateKey: 'otp.login',
        payload: { code: '999111' },
        status: 'pending',
      })
      .returning();
    const [futureRow] = await db
      .insert(notifications)
      .values({
        tenantId,
        channel: 'sms',
        recipient: '+919999999996',
        templateKey: 'otp.login',
        payload: { code: '888222' },
        status: 'pending',
        scheduledFor: new Date(Date.now() + 60 * 60 * 1000), // T+1h
      })
      .returning();

    // Run the drain.
    const attempted = await getNotifications().processPending(10);

    // At least the due row was attempted (other tests may seed more).
    expect(attempted).toBeGreaterThanOrEqual(1);

    const [dueAfter] = await db
      .select()
      .from(notifications)
      .where(sql`id = ${dueRow!.id}`);
    expect(dueAfter?.status).toBe('sent');
    expect(dueAfter?.sentAt).toBeTruthy();

    const [futureAfter] = await db
      .select()
      .from(notifications)
      .where(sql`id = ${futureRow!.id}`);
    expect(futureAfter?.status).toBe('pending');
    expect(futureAfter?.sentAt).toBeNull();
  });

  it('processPending marks a row failed when the template is unknown', async () => {
    const [bad] = await db
      .insert(notifications)
      .values({
        tenantId,
        channel: 'sms',
        recipient: '+919999999995',
        templateKey: 'does.not.exist',
        payload: {},
        status: 'pending',
      })
      .returning();

    await getNotifications().processPending(10);

    const [after] = await db
      .select()
      .from(notifications)
      .where(sql`id = ${bad!.id}`);
    expect(after?.status).toBe('failed');
    expect(after?.error).toMatch(/unknown_template/);
  });

  it('processPending returns 0 when there are no pending rows', async () => {
    // Drain anything queued by prior tests first.
    await getNotifications().processPending(100);
    // Wipe any remaining pending rows for this tenant — should be none, but be safe.
    await db.execute(
      sql`update notifications set status = 'sent', sent_at = now() where tenant_id = ${tenantId} and status = 'pending' and (scheduled_for is null or scheduled_for <= now())`,
    );

    const attempted = await getNotifications().processPending(10);
    expect(attempted).toBe(0);
  });
});
