import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { tenants, tenantMembers, users } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { listMembers, removeMember, updateMemberRole } from './team_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const SUFFIX = Date.now();

describe.skipIf(!runIntegration)('team_service', () => {
  let tenantId: string;
  let owner1: string;
  let owner2: string;
  let staff: string;

  beforeAll(async () => {
    await pingDb();
    const [u1] = await db.insert(users).values({
      firebaseUid: `team-o1-${SUFFIX}`, email: `o1-${SUFFIX}@x.test`,
    }).returning();
    const [u2] = await db.insert(users).values({
      firebaseUid: `team-o2-${SUFFIX}`, email: `o2-${SUFFIX}@x.test`,
    }).returning();
    const [u3] = await db.insert(users).values({
      firebaseUid: `team-s-${SUFFIX}`, email: `s-${SUFFIX}@x.test`,
    }).returning();
    owner1 = u1!.id; owner2 = u2!.id; staff = u3!.id;
    const [t] = await db.insert(tenants).values({
      name: 'Team Co', slug: `team-${SUFFIX}`,
    }).returning();
    tenantId = t!.id;
    await db.insert(tenantMembers).values([
      { userId: owner1, tenantId, role: 'owner' },
      { userId: owner2, tenantId, role: 'owner' },
      { userId: staff, tenantId, role: 'staff' },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id in (${owner1}, ${owner2}, ${staff})`);
    await closeDb();
  });

  it('listMembers returns all three with their roles', async () => {
    const rows = await listMembers(tenantId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.role).sort()).toEqual(['owner', 'owner', 'staff']);
  });

  it('updateMemberRole promotes staff to manager', async () => {
    await updateMemberRole({
      tenantId, targetUserId: staff, actorUserId: owner1, nextRole: 'manager',
    });
    const rows = await listMembers(tenantId);
    expect(rows.find((r) => r.userId === staff)?.role).toBe('manager');
  });

  it('updateMemberRole rejects demoting the last owner', async () => {
    await updateMemberRole({
      tenantId, targetUserId: owner2, actorUserId: owner1, nextRole: 'staff',
    });
    try {
      await expect(
        updateMemberRole({
          tenantId, targetUserId: owner1, actorUserId: owner1, nextRole: 'manager',
        }),
      ).rejects.toMatchObject({ code: 'last_owner_protected' });
    } finally {
      await updateMemberRole({
        tenantId, targetUserId: owner2, actorUserId: owner1, nextRole: 'owner',
      });
    }
  });

  it('removeMember rejects removing the last owner', async () => {
    await updateMemberRole({
      tenantId, targetUserId: owner2, actorUserId: owner1, nextRole: 'staff',
    });
    try {
      await expect(
        removeMember({ tenantId, targetUserId: owner1, actorUserId: owner1 }),
      ).rejects.toMatchObject({ code: 'last_owner_protected' });
    } finally {
      await updateMemberRole({
        tenantId, targetUserId: owner2, actorUserId: owner1, nextRole: 'owner',
      });
    }
  });

  it('removeMember succeeds when ≥2 owners and target is owner', async () => {
    await removeMember({ tenantId, targetUserId: owner2, actorUserId: owner1 });
    try {
      const rows = await listMembers(tenantId);
      expect(rows.find((r) => r.userId === owner2)).toBeUndefined();
    } finally {
      await db.insert(tenantMembers).values({ userId: owner2, tenantId, role: 'owner' });
    }
  });

  it('removeMember succeeds for self-removal even without explicit cap', async () => {
    await removeMember({ tenantId, targetUserId: staff, actorUserId: staff });
    const rows = await listMembers(tenantId);
    expect(rows.find((r) => r.userId === staff)).toBeUndefined();
  });

  it('updateMemberRole throws NotFound for an unknown target', async () => {
    await expect(
      updateMemberRole({
        tenantId,
        targetUserId: '00000000-0000-0000-0000-000000000000',
        actorUserId: owner1,
        nextRole: 'staff',
      }),
    ).rejects.toBeInstanceOf(NotFound);
  });

  it('removeMember throws NotFound for an unknown target', async () => {
    await expect(
      removeMember({
        tenantId,
        targetUserId: '00000000-0000-0000-0000-000000000000',
        actorUserId: owner1,
      }),
    ).rejects.toBeInstanceOf(NotFound);
  });
});
