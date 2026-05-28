import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { tenantRole } from './tenant_members.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Pending team-member invitations. Created by an owner/manager; consumed by
 * the invitee when they click the email link. The plaintext token is kept ONLY
 * in the email — we store its bcrypt hash + a 12-char prefix for indexed
 * lookup (the api_keys pattern).
 */
export const tenantInvitations = pgTable('tenant_invitations', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** Stored lowercased. */
  email: text('email').notNull(),
  role: tenantRole('role').notNull(),
  invitedByUserId: uuid('invited_by_user_id')
    .notNull()
    .references(() => users.id),
  /** First 12 chars of the token (cheap indexed prefix scan). */
  tokenPrefix: text('token_prefix').notNull(),
  /** bcrypt(plaintextToken, 10). */
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedUserId: uuid('accepted_user_id').references(() => users.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export type TenantInvitation = typeof tenantInvitations.$inferSelect;
export type NewTenantInvitation = typeof tenantInvitations.$inferInsert;
