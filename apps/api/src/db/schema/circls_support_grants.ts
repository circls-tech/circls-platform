import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * A partner org letting Circls into its portal for a while ("Get help from
 * Circls"). While a grant is live — not ended and not past `expires_at` — any
 * Circls super admin may open the org (see requireTenantMembership). Asking
 * again while one is live pushes its end back; Remove on the Team page ends
 * it early. Rows are kept as the history of who let Circls in, and when.
 */
export const circlsSupportGrants = pgTable(
  'circls_support_grants',
  {
    id: uuidPk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id),
    /** What the org wants help with, in its own words (optional). */
    note: text('note'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedByUserId: uuid('ended_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('circls_support_grants_tenant_idx').on(t.tenantId, t.expiresAt)],
);

export type CirclsSupportGrant = typeof circlsSupportGrants.$inferSelect;
