import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { notifications } from '../db/schema/notifications.js';
import { tenants, tenantMembers, users } from '../db/schema/index.js';
import { createInvitation } from './invitation_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const SUFFIX = Date.now();

describe.skipIf(!runIntegration)('createInvitation queues an email', () => {
  let tenantId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    await pingDb();
    const [u] = await db.insert(users).values({
      firebaseUid: `disp-fb-${SUFFIX}`, email: `disp-${SUFFIX}@x.test`,
    }).returning();
    ownerUserId = u!.id;
    const [t] = await db.insert(tenants).values({
      name: 'Dispatch Co', slug: `disp-${SUFFIX}`,
    }).returning();
    tenantId = t!.id;
    await db.insert(tenantMembers).values({ userId: ownerUserId, tenantId, role: 'owner' });
  });

  afterAll(async () => {
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_invitations where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${ownerUserId}`);
    await closeDb();
  });

  it('writes a notifications row for the invitee email', async () => {
    await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `target-${SUFFIX}@x.test`,
      role: 'staff',
    });
    const rows = await db
      .select()
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and recipient = ${`target-${SUFFIX}@x.test`}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe('email');
    expect(rows[0]?.templateKey).toBe('tenant.invitation');
  });
});
