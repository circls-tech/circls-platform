import type { TenantRole } from '../../db/schema/tenant_members.js';
import type { Capability } from './capabilities.js';

/** Caps each role gets on a *partner* tenant (isPlatform=false). */
export const PARTNER_CAPS: Record<TenantRole, readonly Capability[]> = {
  owner: [
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
  ],
  manager: [
    'tenant.read', 'tenant.update',
    'members.read', 'members.invite', 'members.role_change', 'members.remove',
    'venues.read', 'venues.write',
    'arenas.read', 'arenas.write',
    'schedules.read', 'schedules.write',
    'pricing.read', 'pricing.write',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read', 'financials.read',
    'events.read', 'events.write',
    'memberships.read', 'memberships.write',
  ],
  staff: [
    'tenant.read',
    'members.read',
    'venues.read', 'arenas.read', 'schedules.read', 'pricing.read',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read',
    'events.read', 'memberships.read',
  ],
  readonly: [
    'tenant.read',
    'members.read',
    'venues.read', 'arenas.read', 'schedules.read', 'pricing.read',
    'bookings.read',
    'analytics.read', 'financials.read',
    'events.read', 'memberships.read',
  ],
} as const;

/** Caps each role gets on the *Circls platform* tenant (isPlatform=true). */
export const PLATFORM_CAPS: Record<TenantRole, readonly Capability[]> = {
  // Founder / CTO: everything platform + everything partner-of-Circls.
  owner: [
    ...PARTNER_CAPS.owner,
    'admin.tenants.read', 'admin.tenants.suspend',
    'admin.listings.review', 'admin.payouts.execute',
    'admin.audit.read',
  ],
  // Ops lead: every admin power; no team mgmt of Circls itself.
  manager: [
    'tenant.read', 'tenant.update',
    'members.read',
    'admin.tenants.read', 'admin.tenants.suspend',
    'admin.listings.review', 'admin.payouts.execute',
    'admin.audit.read',
  ],
  // Ops IC: tenant + listing review + audit, no payout execution, no suspend.
  staff: [
    'tenant.read',
    'members.read',
    'admin.tenants.read',
    'admin.listings.review',
    'admin.audit.read',
  ],
  // Read-only audit / accountant for Circls.
  readonly: [
    'tenant.read',
    'members.read',
    'admin.tenants.read',
    'admin.audit.read',
  ],
} as const;
