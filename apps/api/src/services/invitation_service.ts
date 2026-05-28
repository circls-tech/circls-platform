/**
 * Team-member invitations — Phase D (team management).
 *
 * Lifecycle:
 *   create  → email out, row stored with bcrypt token hash
 *   lookup  → unauth endpoint for the accept page
 *   accept  → unauth; consumes the token, creates a tenant_members row
 *   resend  → rotates token + bumps expires_at
 *   revoke  → soft-revokes the row
 *
 * Token model: 24 random bytes → 32 base64url chars. Stored as bcrypt hash
 * + a 12-char prefix (indexed) for cheap candidate lookup; we bcrypt-compare
 * only the rows whose prefix matches.
 */
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { tenants } from '../db/schema/tenants.js';
import { tenantMembers, type TenantRole } from '../db/schema/tenant_members.js';
import { tenantInvitations, type TenantInvitation } from '../db/schema/tenant_invitations.js';
import { users } from '../db/schema/users.js';
import { writeAudit } from '../lib/audit.js';
import { Conflict, NotFound } from '../lib/errors.js';

const INVITE_TTL_DAYS = 7;
const BCRYPT_ROUNDS = 10;

function mintToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function expiresInDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CreateInvitationResult {
  invitation: TenantInvitation;
  plaintextToken: string;
}

export interface CreateInvitationInput {
  tenantId: string;
  actorUserId: string;
  email: string;
  role: TenantRole;
  ttlDays?: number;
}

export async function createInvitation(
  input: CreateInvitationInput,
): Promise<CreateInvitationResult> {
  const email = normEmail(input.email);

  // Reject if the email is already an active member of this tenant.
  const memberRows = await db
    .select({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(and(eq(tenantMembers.tenantId, input.tenantId), eq(users.email, email)))
    .limit(1);
  if (memberRows.length > 0) {
    throw new Conflict('User is already a member', 'already_member', { email });
  }

  // Auto-revoke an expired (but not yet revoked) invite so the partial unique
  // index doesn't block re-inviting the same address after expiry.
  const [expiredRow] = await db
    .select({ id: tenantInvitations.id })
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.tenantId, input.tenantId),
        eq(tenantInvitations.email, email),
        isNull(tenantInvitations.acceptedAt),
        isNull(tenantInvitations.revokedAt),
        sql`${tenantInvitations.expiresAt} <= now()`,
      ),
    )
    .limit(1);
  if (expiredRow) {
    await db
      .update(tenantInvitations)
      .set({ revokedAt: new Date() })
      .where(eq(tenantInvitations.id, expiredRow.id));
    await writeAudit(
      db,
      { tenantId: input.tenantId, actorUserId: input.actorUserId },
      'tenant.invitation_revoked',
      'invitation',
      expiredRow.id,
      null,
      { reason: 'auto_revoke_expired' },
    );
  }

  const token = mintToken();
  const tokenPrefix = token.slice(0, 12);
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const expiresAt = expiresInDays(input.ttlDays ?? INVITE_TTL_DAYS);

  let inserted: TenantInvitation;
  try {
    const [row] = await db
      .insert(tenantInvitations)
      .values({
        tenantId: input.tenantId,
        email,
        role: input.role,
        invitedByUserId: input.actorUserId,
        tokenPrefix,
        tokenHash,
        expiresAt,
      })
      .returning();
    if (!row) throw new Error('invitation insert returned no row');
    inserted = row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Conflict('A live invitation already exists', 'invitation_already_pending', {
        email,
      });
    }
    throw err;
  }

  await writeAudit(
    db,
    { tenantId: input.tenantId, actorUserId: input.actorUserId },
    'tenant.invitation_sent',
    'invitation',
    inserted.id,
    null,
    { email, role: input.role, expiresAt: inserted.expiresAt },
  );

  return { invitation: inserted, plaintextToken: token };
}

export interface InvitationLookupResult {
  invitationId: string;
  tenantId: string;
  tenantName: string;
  role: TenantRole;
  email: string;
  expiresAt: Date;
  inviterEmail: string | null;
}

export async function lookupInvitation(token: string): Promise<InvitationLookupResult | null> {
  if (token.length < 12) return null;
  const prefix = token.slice(0, 12);
  const candidates = await db
    .select({
      invitationId: tenantInvitations.id,
      tokenHash: tenantInvitations.tokenHash,
      tenantId: tenantInvitations.tenantId,
      tenantName: tenants.name,
      role: tenantInvitations.role,
      email: tenantInvitations.email,
      expiresAt: tenantInvitations.expiresAt,
      inviterEmail: users.email,
    })
    .from(tenantInvitations)
    .innerJoin(tenants, eq(tenants.id, tenantInvitations.tenantId))
    .leftJoin(users, eq(users.id, tenantInvitations.invitedByUserId))
    .where(
      and(
        eq(tenantInvitations.tokenPrefix, prefix),
        isNull(tenantInvitations.acceptedAt),
        isNull(tenantInvitations.revokedAt),
        sql`${tenantInvitations.expiresAt} > now()`,
      ),
    );
  for (const c of candidates) {
    const match = await bcrypt.compare(token, c.tokenHash);
    if (match) {
      return {
        invitationId: c.invitationId,
        tenantId: c.tenantId,
        tenantName: c.tenantName,
        role: c.role,
        email: c.email,
        expiresAt: c.expiresAt,
        inviterEmail: c.inviterEmail,
      };
    }
  }
  return null;
}

export interface AcceptInvitationInput {
  token: string;
  firebaseUid: string;
  email: string;
}

export interface AcceptInvitationResult {
  invitationId: string;
  tenantId: string;
  userId: string;
  role: TenantRole;
}

export async function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  const tokenEmail = normEmail(input.email);
  const meta = await lookupInvitation(input.token);
  if (!meta) {
    throw new NotFound('Invitation not found or already used', 'invitation_not_found');
  }
  if (meta.email !== tokenEmail) {
    throw new Conflict('Token email does not match invitation', 'invitation_email_mismatch');
  }

  return db.transaction(async (tx) => {
    let [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.firebaseUid, input.firebaseUid))
      .limit(1);
    if (!existing) {
      const [created] = await tx
        .insert(users)
        .values({ firebaseUid: input.firebaseUid, email: tokenEmail })
        .onConflictDoNothing({ target: users.firebaseUid })
        .returning();
      if (created) {
        existing = { id: created.id };
      } else {
        const [refetch] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.firebaseUid, input.firebaseUid))
          .limit(1);
        existing = refetch!;
      }
    }

    await tx
      .insert(tenantMembers)
      .values({ userId: existing.id, tenantId: meta.tenantId, role: meta.role })
      .onConflictDoNothing({ target: [tenantMembers.userId, tenantMembers.tenantId] });

    const acceptedAt = new Date();
    const claimed = await tx
      .update(tenantInvitations)
      .set({ acceptedAt, acceptedUserId: existing.id })
      .where(
        and(
          eq(tenantInvitations.id, meta.invitationId),
          isNull(tenantInvitations.acceptedAt),
        ),
      )
      .returning({ id: tenantInvitations.id });
    if (claimed.length === 0) {
      throw new Conflict('Invitation already accepted', 'already_accepted');
    }

    await writeAudit(
      tx,
      { tenantId: meta.tenantId, actorUserId: existing.id },
      'tenant.invitation_accepted',
      'invitation',
      meta.invitationId,
      { acceptedAt: null },
      { acceptedAt, acceptedUserId: existing.id },
    );
    await writeAudit(
      tx,
      { tenantId: meta.tenantId, actorUserId: existing.id },
      'tenant.member_added',
      'tenant_member',
      existing.id,
      null,
      { userId: existing.id, role: meta.role, source: 'invitation' },
    );

    return {
      invitationId: meta.invitationId,
      tenantId: meta.tenantId,
      userId: existing.id,
      role: meta.role,
    };
  });
}

export interface ResendInvitationInput {
  tenantId: string;
  invitationId: string;
  actorUserId: string;
  ttlDays?: number;
}

export async function resendInvitation(
  input: ResendInvitationInput,
): Promise<CreateInvitationResult> {
  const token = mintToken();
  const tokenPrefix = token.slice(0, 12);
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const expiresAt = expiresInDays(input.ttlDays ?? INVITE_TTL_DAYS);

  const [previous] = await db
    .select({ tokenPrefix: tenantInvitations.tokenPrefix, expiresAt: tenantInvitations.expiresAt })
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.id, input.invitationId),
        eq(tenantInvitations.tenantId, input.tenantId),
        isNull(tenantInvitations.acceptedAt),
        isNull(tenantInvitations.revokedAt),
      ),
    )
    .limit(1);
  if (!previous) throw new NotFound('Invitation not found', 'invitation_not_found');

  const [updated] = await db
    .update(tenantInvitations)
    .set({ tokenPrefix, tokenHash, expiresAt })
    .where(
      and(
        eq(tenantInvitations.id, input.invitationId),
        isNull(tenantInvitations.acceptedAt),
        isNull(tenantInvitations.revokedAt),
      ),
    )
    .returning();
  if (!updated) throw new NotFound('Invitation not found', 'invitation_not_found');

  await writeAudit(
    db,
    { tenantId: input.tenantId, actorUserId: input.actorUserId },
    'tenant.invitation_resent',
    'invitation',
    updated.id,
    { tokenPrefix: previous.tokenPrefix, expiresAt: previous.expiresAt },
    { tokenPrefix, expiresAt },
  );

  return { invitation: updated, plaintextToken: token };
}

export interface RevokeInvitationInput {
  tenantId: string;
  invitationId: string;
  actorUserId: string;
}

export async function revokeInvitation(input: RevokeInvitationInput): Promise<void> {
  const [updated] = await db
    .update(tenantInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(tenantInvitations.id, input.invitationId),
        eq(tenantInvitations.tenantId, input.tenantId),
        isNull(tenantInvitations.revokedAt),
        isNull(tenantInvitations.acceptedAt),
      ),
    )
    .returning();
  if (!updated) return;

  await writeAudit(
    db,
    { tenantId: input.tenantId, actorUserId: input.actorUserId },
    'tenant.invitation_revoked',
    'invitation',
    updated.id,
    { revokedAt: null },
    { revokedAt: updated.revokedAt },
  );
}

export async function listInvitations(
  tenantId: string,
  status?: 'pending' | 'accepted' | 'expired' | 'revoked',
): Promise<TenantInvitation[]> {
  if (status === 'pending') {
    return db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          isNull(tenantInvitations.acceptedAt),
          isNull(tenantInvitations.revokedAt),
          sql`${tenantInvitations.expiresAt} > now()`,
        ),
      );
  }
  if (status === 'accepted') {
    return db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          isNotNull(tenantInvitations.acceptedAt),
        ),
      );
  }
  if (status === 'expired') {
    return db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          isNull(tenantInvitations.acceptedAt),
          isNull(tenantInvitations.revokedAt),
          sql`${tenantInvitations.expiresAt} <= now()`,
        ),
      );
  }
  if (status === 'revoked') {
    return db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          isNotNull(tenantInvitations.revokedAt),
        ),
      );
  }
  return db.select().from(tenantInvitations).where(eq(tenantInvitations.tenantId, tenantId));
}
