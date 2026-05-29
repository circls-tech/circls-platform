/**
 * Team service — list members, change role, remove member.
 *
 * Owner-safety invariants (enforced here, not at capability layer):
 *   - cannot demote the last owner
 *   - cannot remove the last owner
 *
 * Self-removal exception (enforced at the route layer):
 *   - DELETE on yourself is allowed regardless of cap, provided the last-owner
 *     invariant still holds.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantMembers, type TenantRole } from '../db/schema/tenant_members.js';
import { users } from '../db/schema/users.js';
import { writeAudit } from '../lib/audit.js';
import { Conflict, NotFound } from '../lib/errors.js';

export interface MemberRow {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: TenantRole;
  createdAt: Date;
}

export async function listMembers(tenantId: string): Promise<MemberRow[]> {
  return db
    .select({
      userId: tenantMembers.userId,
      email: users.email,
      displayName: users.displayName,
      role: tenantMembers.role,
      createdAt: tenantMembers.createdAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(eq(tenantMembers.tenantId, tenantId));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Lock owner rows for this tenant so concurrent demotions serialize. */
async function lockedOwnerCount(tx: Tx, tenantId: string): Promise<number> {
  const rows = await tx
    .select({ id: tenantMembers.userId })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, 'owner')))
    .for('update');
  return rows.length;
}

export interface UpdateMemberRoleInput {
  tenantId: string;
  targetUserId: string;
  actorUserId: string;
  nextRole: TenantRole;
}

export async function updateMemberRole(input: UpdateMemberRoleInput): Promise<MemberRow> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        role: tenantMembers.role,
        email: users.email,
        displayName: users.displayName,
        createdAt: tenantMembers.createdAt,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.targetUserId)),
      )
      .limit(1);
    if (!current) throw new NotFound('Member not found', 'member_not_found');

    if (current.role === 'owner' && input.nextRole !== 'owner') {
      const n = await lockedOwnerCount(tx, input.tenantId);
      if (n <= 1) {
        throw new Conflict('Cannot demote the last owner', 'last_owner_protected');
      }
    }

    const [updated] = await tx
      .update(tenantMembers)
      .set({ role: input.nextRole })
      .where(
        and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.targetUserId)),
      )
      .returning();
    if (!updated) throw new NotFound('Member not found', 'member_not_found');

    await writeAudit(
      tx,
      { tenantId: input.tenantId, actorUserId: input.actorUserId },
      'tenant.member_role_changed',
      'tenant_member',
      input.targetUserId,
      { role: current.role },
      { role: input.nextRole },
    );

    return {
      userId: input.targetUserId,
      email: current.email,
      displayName: current.displayName,
      role: input.nextRole,
      createdAt: current.createdAt,
    };
  });
}

export interface RemoveMemberInput {
  tenantId: string;
  targetUserId: string;
  actorUserId: string;
}

export async function removeMember(input: RemoveMemberInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ role: tenantMembers.role })
      .from(tenantMembers)
      .where(
        and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.targetUserId)),
      )
      .limit(1);
    if (!current) throw new NotFound('Member not found', 'member_not_found');

    if (current.role === 'owner') {
      const n = await lockedOwnerCount(tx, input.tenantId);
      if (n <= 1) {
        throw new Conflict('Cannot remove the last owner', 'last_owner_protected');
      }
    }

    await tx
      .delete(tenantMembers)
      .where(
        and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.targetUserId)),
      );

    await writeAudit(
      tx,
      { tenantId: input.tenantId, actorUserId: input.actorUserId },
      'tenant.member_removed',
      'tenant_member',
      input.targetUserId,
      { role: current.role },
      { removedAt: new Date() },
    );
  });
}
