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
import { tenantMembers, ROLE_RANK, type TenantRole } from '../db/schema/tenant_members.js';
import { tenantInvitations, type TenantInvitation } from '../db/schema/tenant_invitations.js';
import { users } from '../db/schema/users.js';
import { writeAudit } from '../lib/audit.js';
import { Conflict, Forbidden, NotFound } from '../lib/errors.js';
import { env } from '../config/env.js';
import { getNotifications } from '../lib/notifications/index.js';
import { logger } from '../lib/logger.js';

const INVITE_TTL_DAYS = 7;
const BCRYPT_ROUNDS = 10;

export interface PublicInvitation {
  id: string;
  tenantId: string;
  email: string;
  role: TenantRole;
  invitedByUserId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedUserId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function toPublic(row: TenantInvitation): PublicInvitation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    role: row.role,
    invitedByUserId: row.invitedByUserId,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    acceptedUserId: row.acceptedUserId,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

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
  invitation: PublicInvitation;
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

  // Resolve tenant name + inviter email for the email body.
  const [tenantRow] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId))
    .limit(1);
  const [inviterRow] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, input.actorUserId))
    .limit(1);
  const tenantName = tenantRow?.name ?? 'your team';
  const inviterName = inviterRow?.displayName ?? inviterRow?.email ?? 'A teammate';

  const inviteUrl = `${env.PARTNERS_BASE_URL}/invite/${token}`;

  // Fire-and-await the dispatch. The dispatcher writes a notifications row even
  // in stub mode, so the audit + UI surface work.
  try {
    await getNotifications().dispatch({
      tenantId: input.tenantId,
      channel: 'email',
      recipient: email,
      templateKey: 'tenant.invitation',
      payload: {
        tenantName,
        inviterName,
        role: input.role,
        inviteUrl,
        expiresAtIso: expiresAt.toISOString(),
      },
    });
  } catch (err) {
    // Best-effort. The invitation + audit are already committed; we surface a
    // log instead of failing the whole request so the caller can still see the
    // invitation in /v1/tenants/:id/invitations and trigger a resend.
    logger.warn({ err, invitationId: inserted.id }, 'invitation_dispatch_failed');
  }

  return { invitation: toPublic(inserted), plaintextToken: token };
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
  /**
   * Whether the accepting Firebase token's email was already verified. An
   * unverified token is allowed to CREATE a fresh identity (the secret invite
   * token proves inbox control), but is refused when it would ADOPT a
   * pre-existing user row onto a new uid — that would be account takeover (C1).
   */
  emailVerified: boolean;
}

export interface AcceptInvitationResult {
  invitationId: string;
  tenantId: string;
  tenantName: string;
  userId: string;
  /** The member's effective role after accepting (post-bump). */
  role: TenantRole;
  /** True if the user was already a member of this tenant before accepting. */
  alreadyMember: boolean;
  /** True if accepting raised the member to a higher role. */
  roleChanged: boolean;
  /** The member's role before accepting, when they were already a member. */
  previousRole: TenantRole | null;
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
      // The invitee may already have a `users` row under tokenEmail but a
      // different firebase_uid (signed in via another provider before accepting).
      // Adopt that row onto the new uid rather than tripping users_email_unique
      // on the insert below — the firebase_uid lookup above came back empty, so
      // the new uid is free.
      const [byEmail] = await tx
        .select({ id: users.id, firebaseUid: users.firebaseUid })
        .from(users)
        .where(eq(users.email, tokenEmail))
        .limit(1);
      if (byEmail) {
        if (byEmail.firebaseUid !== input.firebaseUid) {
          // Re-binding an existing identity onto a new uid is account takeover
          // unless the incoming token actually owns (verified) the email. The
          // secret invite token is enough to JOIN as a new user, but never to
          // hijack a pre-existing account (C1 guard).
          if (!input.emailVerified) {
            throw new Forbidden('Email not verified', 'email_unverified');
          }
          await tx
            .update(users)
            .set({ firebaseUid: input.firebaseUid })
            .where(eq(users.id, byEmail.id));
        }
        existing = { id: byEmail.id };
      } else {
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
    }

    // Are they already a member of this tenant? If so, the invite is a no-op
    // for membership — but we still bump their role when the invite grants a
    // strictly higher one. Otherwise we add them as a new member.
    const [currentMember] = await tx
      .select({ role: tenantMembers.role })
      .from(tenantMembers)
      .where(
        and(
          eq(tenantMembers.userId, existing.id),
          eq(tenantMembers.tenantId, meta.tenantId),
        ),
      )
      .limit(1);

    const alreadyMember = currentMember != null;
    const previousRole = currentMember?.role ?? null;
    let roleChanged = false;
    let effectiveRole = meta.role;

    if (currentMember) {
      if (ROLE_RANK[meta.role] > ROLE_RANK[currentMember.role]) {
        await tx
          .update(tenantMembers)
          .set({ role: meta.role })
          .where(
            and(
              eq(tenantMembers.userId, existing.id),
              eq(tenantMembers.tenantId, meta.tenantId),
            ),
          );
        roleChanged = true;
        effectiveRole = meta.role;
      } else {
        // Same or lower role — keep their existing (higher-or-equal) role.
        effectiveRole = currentMember.role;
      }
    } else {
      await tx
        .insert(tenantMembers)
        .values({ userId: existing.id, tenantId: meta.tenantId, role: meta.role })
        .onConflictDoNothing({ target: [tenantMembers.userId, tenantMembers.tenantId] });
    }

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
    if (!alreadyMember) {
      await writeAudit(
        tx,
        { tenantId: meta.tenantId, actorUserId: existing.id },
        'tenant.member_added',
        'tenant_member',
        existing.id,
        null,
        { userId: existing.id, role: meta.role, source: 'invitation' },
      );
    } else if (roleChanged) {
      await writeAudit(
        tx,
        { tenantId: meta.tenantId, actorUserId: existing.id },
        'tenant.member_role_changed',
        'tenant_member',
        existing.id,
        { role: previousRole },
        { role: effectiveRole, source: 'invitation' },
      );
    }

    return {
      invitationId: meta.invitationId,
      tenantId: meta.tenantId,
      tenantName: meta.tenantName,
      userId: existing.id,
      role: effectiveRole,
      alreadyMember,
      roleChanged,
      previousRole,
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
    .select({
      tokenPrefix: tenantInvitations.tokenPrefix,
      expiresAt: tenantInvitations.expiresAt,
      email: tenantInvitations.email,
      role: tenantInvitations.role,
    })
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

  // Resolve tenant name + inviter email for the resent email body.
  const [resendTenantRow] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId))
    .limit(1);
  const [resendInviterRow] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, input.actorUserId))
    .limit(1);
  const resendTenantName = resendTenantRow?.name ?? 'your team';
  const resendInviterName = resendInviterRow?.displayName ?? resendInviterRow?.email ?? 'A teammate';

  const resendInviteUrl = `${env.PARTNERS_BASE_URL}/invite/${token}`;

  try {
    await getNotifications().dispatch({
      tenantId: input.tenantId,
      channel: 'email',
      recipient: previous.email,
      templateKey: 'tenant.invitation',
      payload: {
        tenantName: resendTenantName,
        inviterName: resendInviterName,
        role: previous.role,
        inviteUrl: resendInviteUrl,
        expiresAtIso: expiresAt.toISOString(),
      },
    });
  } catch (err) {
    // Best-effort. The invitation + audit are already committed; we surface a
    // log instead of failing the whole request so the caller can still see the
    // invitation in /v1/tenants/:id/invitations and trigger a resend.
    logger.warn({ err, invitationId: updated.id }, 'invitation_dispatch_failed');
  }

  return { invitation: toPublic(updated), plaintextToken: token };
}

export interface RevokeInvitationInput {
  tenantId: string;
  invitationId: string;
  actorUserId: string;
}

export async function revokeInvitation(input: RevokeInvitationInput): Promise<void> {
  // SELECT first to distinguish "not found" vs "already accepted/revoked".
  const [existing] = await db
    .select({
      id: tenantInvitations.id,
      acceptedAt: tenantInvitations.acceptedAt,
      revokedAt: tenantInvitations.revokedAt,
    })
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.id, input.invitationId),
        eq(tenantInvitations.tenantId, input.tenantId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new NotFound('Invitation not found', 'invitation_not_found');
  }
  if (existing.acceptedAt !== null) {
    throw new Conflict('Cannot revoke an accepted invitation', 'invitation_already_accepted');
  }
  // Already revoked — idempotent, return silently.
  if (existing.revokedAt !== null) return;

  const revokedAt = new Date();
  await db
    .update(tenantInvitations)
    .set({ revokedAt })
    .where(eq(tenantInvitations.id, input.invitationId));

  await writeAudit(
    db,
    { tenantId: input.tenantId, actorUserId: input.actorUserId },
    'tenant.invitation_revoked',
    'invitation',
    existing.id,
    { revokedAt: null },
    { revokedAt },
  );
}

export async function listInvitations(
  tenantId: string,
  status?: 'pending' | 'accepted' | 'expired' | 'revoked',
): Promise<PublicInvitation[]> {
  let rows: TenantInvitation[];
  if (status === 'pending') {
    rows = await db
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
  } else if (status === 'accepted') {
    rows = await db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          isNotNull(tenantInvitations.acceptedAt),
        ),
      );
  } else if (status === 'expired') {
    rows = await db
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
  } else if (status === 'revoked') {
    rows = await db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          isNotNull(tenantInvitations.revokedAt),
        ),
      );
  } else {
    rows = await db
      .select()
      .from(tenantInvitations)
      .where(eq(tenantInvitations.tenantId, tenantId));
  }
  return rows.map(toPublic);
}
