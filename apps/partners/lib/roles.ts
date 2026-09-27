import type { TenantRole } from '@/lib/api/types';

/**
 * Display metadata for partner-tenant roles. Descriptions must stay in sync
 * with the capability grants in apps/api/src/lib/authz/role_caps.ts
 * (PARTNER_CAPS) and the Help Centre article content/help/team.md.
 */
export const ROLE_ORDER: TenantRole[] = ['owner', 'manager', 'staff', 'readonly'];

export const ROLE_INFO: Record<TenantRole, { label: string; description: string }> = {
  owner: {
    label: 'Owner',
    description:
      'Full control — manage the team, venues, arenas, schedules, pricing, bookings, events, memberships and discounts; view financials, issue refunds, manage API keys, and update or delete the organisation.',
  },
  manager: {
    label: 'Manager',
    description:
      'Everything an Owner can do — team, venues, schedules, pricing, bookings, events, financials, refunds and API keys — except delete the organisation.',
  },
  staff: {
    label: 'Staff',
    description:
      'Day-to-day operations — create and cancel bookings, view analytics, and answer customer questions. Can view venues, schedules, pricing, events and memberships but not change them. No team management or financial reports.',
  },
  readonly: {
    label: 'Read-only',
    description:
      'View-only access to everything, including financial reports and analytics. Cannot create, change or delete anything.',
  },
};

/** Label for a role value that may come back untyped from the API. */
export function formatRole(role: string): string {
  return ROLE_INFO[role as TenantRole]?.label ?? role;
}

/**
 * The capabilities the portal hides actions behind. `bookings.cancel` covers
 * cancelling — and so refunding — a booking, an event registration or a
 * member's purchase.
 */
export type PortalCapability = 'bookings.cancel';

/**
 * Those capabilities' grants in PARTNER_CAPS (apps/api/src/lib/authz/role_caps.ts).
 * The API enforces them either way; this only keeps the portal from offering
 * what it will refuse.
 */
const ROLE_CAPS: Record<TenantRole, readonly PortalCapability[]> = {
  owner: ['bookings.cancel'],
  manager: ['bookings.cancel'],
  staff: ['bookings.cancel'],
  readonly: [],
};

/**
 * Whether `role` holds `cap`. No role (still loading, or not a member) holds
 * nothing, and nor does one this build doesn't know yet.
 */
export function roleCan(role: TenantRole | null | undefined, cap: PortalCapability): boolean {
  return role != null && (ROLE_CAPS[role]?.includes(cap) ?? false);
}
