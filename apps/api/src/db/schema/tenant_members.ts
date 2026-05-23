import { jsonb, pgEnum, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './_columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/** Many-to-many: which Users may act for which Tenant, in which role. */
export const tenantRole = pgEnum('tenant_role', ['owner', 'manager', 'staff', 'readonly']);

export const tenantMembers = pgTable(
  'tenant_members',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    role: tenantRole('role').notNull(),
    permissionsOverride: jsonb('permissions_override'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tenantId] })],
);

export type TenantMember = typeof tenantMembers.$inferSelect;
export type NewTenantMember = typeof tenantMembers.$inferInsert;
