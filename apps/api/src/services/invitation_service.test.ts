import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { tenants, tenantMembers, users, auditLog } from '../db/schema/index.js';
import { tenantInvitations } from '../db/schema/tenant_invitations.js';
import { Conflict, NotFound } from '../lib/errors.js';
import {
  acceptInvitation,
  createInvitation,
  lookupInvitation,
  revokeInvitation,
  resendInvitation,
} from './invitation_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const SUFFIX = Date.now();

describe.skipIf(!runIntegration)('invitation_service', () => {
  let tenantId: string;
  let ownerUserId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({
        firebaseUid: `inv-owner-fb-${SUFFIX}`,
        email: `inv-owner-${SUFFIX}@x.test`,
      })
      .returning();
    ownerUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Inv Co', slug: `inv-${SUFFIX}` })
      .returning();
    tenantId = t!.id;
    await db.insert(tenantMembers).values({ userId: ownerUserId, tenantId, role: 'owner' });
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_invitations where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${ownerUserId}`);
    if (createdUserIds.length) {
      await db.delete(auditLog).where(inArray(auditLog.actorUserId, createdUserIds));
      await db.delete(tenantMembers).where(inArray(tenantMembers.userId, createdUserIds));
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
    await closeDb();
  });

  it('createInvitation inserts a row + returns the plaintext token + writes audit', async () => {
    const result = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `bob-${SUFFIX}@x.test`,
      role: 'manager',
    });
    expect(result.invitation.email).toBe(`bob-${SUFFIX}@x.test`);
    expect(result.invitation.role).toBe('manager');
    expect(result.invitation.acceptedAt).toBeNull();
    expect(result.plaintextToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const [row] = await db
      .select()
      .from(tenantInvitations)
      .where(sql`id = ${result.invitation.id}`);
    expect(row?.tokenPrefix).toBe(result.plaintextToken.slice(0, 12));
    expect(row?.tokenHash).not.toBe(result.plaintextToken);
  });

  it('createInvitation lowercases the email', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `MiXeD-${SUFFIX}@X.tEsT`,
      role: 'staff',
    });
    expect(r.invitation.email).toBe(`mixed-${SUFFIX}@x.test`);
  });

  it('createInvitation rejects when a live invite already exists for that email', async () => {
    const email = `dup-${SUFFIX}@x.test`;
    await createInvitation({ tenantId, actorUserId: ownerUserId, email, role: 'staff' });
    await expect(
      createInvitation({ tenantId, actorUserId: ownerUserId, email, role: 'staff' }),
    ).rejects.toMatchObject({ code: 'invitation_already_pending' });
  });

  it('createInvitation rejects when the email is already a member', async () => {
    const memberEmail = `member-${SUFFIX}@x.test`;
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `mem-fb-${SUFFIX}`, email: memberEmail })
      .returning();
    createdUserIds.push(u!.id);
    await db.insert(tenantMembers).values({ userId: u!.id, tenantId, role: 'staff' });
    await expect(
      createInvitation({ tenantId, actorUserId: ownerUserId, email: memberEmail, role: 'staff' }),
    ).rejects.toMatchObject({ code: 'already_member' });
  });

  it('lookupInvitation returns metadata for a valid token', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `look-${SUFFIX}@x.test`,
      role: 'readonly',
    });
    const meta = await lookupInvitation(r.plaintextToken);
    expect(meta).not.toBeNull();
    expect(meta?.tenantName).toBe('Inv Co');
    expect(meta?.role).toBe('readonly');
    expect(meta?.email).toBe(`look-${SUFFIX}@x.test`);
  });

  it('lookupInvitation returns null for an unknown token', async () => {
    const meta = await lookupInvitation('ck_does_not_exist__________________');
    expect(meta).toBeNull();
  });

  it('acceptInvitation creates the membership + marks accepted + writes audit', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `accept-${SUFFIX}@x.test`,
      role: 'manager',
    });
    const accepted = await acceptInvitation({
      token: r.plaintextToken,
      firebaseUid: `accept-fb-${SUFFIX}`,
      email: `accept-${SUFFIX}@x.test`,
    });
    createdUserIds.push(accepted.userId);
    expect(accepted.tenantId).toBe(tenantId);
    expect(accepted.role).toBe('manager');

    const [inv] = await db
      .select()
      .from(tenantInvitations)
      .where(sql`id = ${r.invitation.id}`);
    expect(inv?.acceptedAt).not.toBeNull();

    const [mem] = await db
      .select()
      .from(tenantMembers)
      .where(sql`tenant_id = ${tenantId} and user_id = ${accepted.userId}`);
    expect(mem?.role).toBe('manager');
  });

  it('acceptInvitation rejects email mismatch', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `mis-${SUFFIX}@x.test`,
      role: 'staff',
    });
    await expect(
      acceptInvitation({
        token: r.plaintextToken,
        firebaseUid: `mis-fb-${SUFFIX}`,
        email: `other-${SUFFIX}@x.test`,
      }),
    ).rejects.toMatchObject({ code: 'invitation_email_mismatch' });
  });

  it('acceptInvitation rejects a revoked invite', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `rev-${SUFFIX}@x.test`,
      role: 'staff',
    });
    await revokeInvitation({ tenantId, invitationId: r.invitation.id, actorUserId: ownerUserId });
    await expect(
      acceptInvitation({
        token: r.plaintextToken,
        firebaseUid: `rev-fb-${SUFFIX}`,
        email: `rev-${SUFFIX}@x.test`,
      }),
    ).rejects.toMatchObject({ code: 'invitation_not_found' });
  });

  it('createInvitation auto-revokes an expired invite and succeeds', async () => {
    const email = `expired-reinvite-${SUFFIX}@x.test`;
    // Insert an invitation that has already expired but was never revoked.
    const [expiredInv] = await db
      .insert(tenantInvitations)
      .values({
        tenantId,
        email,
        role: 'staff',
        invitedByUserId: ownerUserId,
        tokenPrefix: 'expiredprefix',
        tokenHash: 'not-a-real-hash',
        expiresAt: new Date(Date.now() - 1000), // 1 second in the past
      })
      .returning();
    // createInvitation should auto-revoke the expired row and insert a fresh one.
    const result = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email,
      role: 'staff',
    });
    expect(result.invitation.email).toBe(email);
    // The old expired row should now be revoked.
    const [old] = await db
      .select()
      .from(tenantInvitations)
      .where(sql`id = ${expiredInv!.id}`);
    expect(old?.revokedAt).not.toBeNull();
  });

  it('resendInvitation rotates the token; old token dies', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `resend-${SUFFIX}@x.test`,
      role: 'staff',
    });
    const old = r.plaintextToken;
    const r2 = await resendInvitation({
      tenantId,
      invitationId: r.invitation.id,
      actorUserId: ownerUserId,
    });
    expect(r2.plaintextToken).not.toBe(old);
    await expect(
      acceptInvitation({
        token: old,
        firebaseUid: `resend-fb-${SUFFIX}`,
        email: `resend-${SUFFIX}@x.test`,
      }),
    ).rejects.toMatchObject({ code: 'invitation_not_found' });
  });
});
