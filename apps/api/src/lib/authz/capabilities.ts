/**
 * Flat capability enum. Authz checks call `can(ctx, cap)`; routes call
 * `requireCap(cap)`. Adding a new entry here forces the snapshot tests in
 * can.test.ts to fail until every role's grant set is reviewed — default-deny.
 */
export type Capability =
  // tenant
  | 'tenant.read'
  | 'tenant.update'
  | 'tenant.delete'
  // members
  | 'members.read'
  | 'members.invite'
  | 'members.role_change'
  | 'members.remove'
  // partner ops
  | 'venues.read'
  | 'venues.write'
  | 'arenas.read'
  | 'arenas.write'
  | 'schedules.read'
  | 'schedules.write'
  | 'pricing.read'
  | 'pricing.write'
  | 'bookings.read'
  | 'bookings.create'
  | 'bookings.cancel'
  | 'analytics.read'
  | 'financials.read'
  | 'events.read'
  | 'events.write'
  | 'memberships.read'
  | 'memberships.write'
  // platform-only (granted only when ctx.tenant.isPlatform === true)
  | 'admin.tenants.read'
  | 'admin.tenants.suspend'
  | 'admin.listings.review'
  | 'admin.payouts.execute'
  | 'admin.audit.read';

/** Used by snapshot tests + by tooling that needs to walk every capability. */
export const ALL_CAPABILITIES: readonly Capability[] = [
  'tenant.read', 'tenant.update', 'tenant.delete',
  'members.read', 'members.invite', 'members.role_change', 'members.remove',
  'venues.read', 'venues.write',
  'arenas.read', 'arenas.write',
  'schedules.read', 'schedules.write',
  'pricing.read', 'pricing.write',
  'bookings.read', 'bookings.create', 'bookings.cancel',
  'analytics.read', 'financials.read',
  'events.read', 'events.write',
  'memberships.read', 'memberships.write',
  'admin.tenants.read', 'admin.tenants.suspend',
  'admin.listings.review', 'admin.payouts.execute',
  'admin.audit.read',
] as const;
