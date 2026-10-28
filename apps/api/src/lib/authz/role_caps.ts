import type { TenantRole } from '../../db/schema/tenant_members.js';
import type { Capability } from './capabilities.js';

/** Caps each role gets on a *partner* tenant (isPlatform=false). */
export const PARTNER_CAPS: Record<TenantRole, readonly Capability[]> = {
  owner: [
    'tenant.read', 'tenant.update', 'tenant.delete',
    'members.read', 'members.invite', 'members.role_change', 'members.update', 'members.remove',
    'venues.read', 'venues.write',
    'arenas.read', 'arenas.write',
    'schedules.read', 'schedules.write',
    'pricing.read', 'pricing.write',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read', 'financials.read',
    'payments.refund',
    'events.read', 'events.write',
    'memberships.read', 'memberships.write',
    'discounts.read', 'discounts.write',
    'questions.read', 'questions.write',
    'integration.read', 'integration.api_keys.manage',
  ],
  manager: [
    'tenant.read', 'tenant.update',
    'members.read', 'members.invite', 'members.role_change', 'members.update', 'members.remove',
    'venues.read', 'venues.write',
    'arenas.read', 'arenas.write',
    'schedules.read', 'schedules.write',
    'pricing.read', 'pricing.write',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read', 'financials.read',
    'payments.refund',
    'events.read', 'events.write',
    'memberships.read', 'memberships.write',
    'discounts.read', 'discounts.write',
    'questions.read', 'questions.write',
    'integration.read', 'integration.api_keys.manage',
  ],
  staff: [
    'tenant.read',
    'members.read',
    'venues.read', 'arenas.read', 'schedules.read', 'pricing.read',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read',
    'events.read', 'memberships.read',
    'discounts.read',
    'questions.read', 'questions.write',
  ],
  readonly: [
    'tenant.read',
    'members.read',
    'venues.read', 'arenas.read', 'schedules.read', 'pricing.read',
    'bookings.read',
    'analytics.read', 'financials.read',
    'events.read', 'memberships.read',
    'discounts.read',
    'questions.read',
  ],
} as const;

/** Managing the Circls team itself: platform Owners only. */
const CIRCLS_TEAM_MANAGEMENT: readonly Capability[] = [
  'members.invite', 'members.role_change', 'members.update', 'members.remove',
];

/**
 * What a super admin may not do in a partner org: run its team or its API
 * keys, read its Earnings, or change its settings — the profile, logo and
 * email preferences, and accepting the Terms, which binds the org.
 */
const SUPER_ADMIN_WITHHELD: readonly Capability[] = [
  'members.invite', 'members.role_change', 'members.update', 'members.remove',
  'integration.api_keys.manage',
  'financials.read',
  'tenant.update',
];

/**
 * Caps a Circls super admin gets in a partner org they are not a member of:
 * a Manager's, so they can set up venues, events, memberships and the rest
 * for the org, less SUPER_ADMIN_WITHHELD. Deleting the org is an Owner's,
 * not a Manager's, so they never had it.
 */
export const SUPER_ADMIN_CAPS: readonly Capability[] = PARTNER_CAPS.manager.filter(
  (cap) => !SUPER_ADMIN_WITHHELD.includes(cap),
);

/** Caps each role gets on the *Circls platform* tenant (isPlatform=true). */
export const PLATFORM_CAPS: Record<TenantRole, readonly Capability[]> = {
  // Founder / CTO: everything platform + everything partner-of-Circls.
  owner: [
    ...PARTNER_CAPS.owner,
    'admin.tenants.read', 'admin.tenants.suspend', 'admin.tenants.billing',
    'admin.users.read',
    'admin.listings.review', 'admin.payouts.read', 'admin.payouts.execute',
    'admin.audit.read',
    'admin.coupons.read', 'admin.coupons.write',
    'admin.support.read', 'admin.support.write',
  ],
  // Ops lead: every admin power, and runs the Circls organisation's own
  // venues, events, memberships, bookings and the rest like a partner Manager
  // does — but doesn't manage the Circls team, which decides who can use the
  // admin console.
  manager: [
    ...PARTNER_CAPS.manager.filter((cap) => !CIRCLS_TEAM_MANAGEMENT.includes(cap)),
    'admin.tenants.read', 'admin.tenants.suspend', 'admin.tenants.billing',
    // The consumer and partner user reports (contact details, CSV exports).
    'admin.users.read',
    'admin.listings.review', 'admin.payouts.read', 'admin.payouts.execute',
    'admin.audit.read',
    'admin.coupons.read', 'admin.coupons.write',
    'admin.support.read', 'admin.support.write',
  ],
  // Ops IC: tenant + listing review + audit + payout visibility, no execution.
  staff: [
    'tenant.read',
    'members.read',
    'admin.tenants.read',
    'admin.listings.review',
    'admin.payouts.read',
    'admin.audit.read',
    'admin.coupons.read',
    'admin.support.read', 'admin.support.write',
  ],
  // Read-only audit / accountant for Circls — sees payouts, can't execute them.
  readonly: [
    'tenant.read',
    'members.read',
    'admin.tenants.read',
    'admin.payouts.read',
    'admin.audit.read',
    'admin.coupons.read',
    'admin.support.read',
  ],
} as const;
