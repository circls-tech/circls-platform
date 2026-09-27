import type { Tenant, TenantRole } from '@/lib/api/types';

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
      'Everything an Owner can do — team, venues, schedules, pricing, bookings, events, financials, refunds and API keys — except delete the organisation, or make, change or remove an Owner.',
  },
  staff: {
    label: 'Staff',
    description:
      'Day-to-day operations — create and cancel bookings, run the event door and membership desks (add registrations and members; renew, cancel or refund members), view analytics, and answer customer questions. Can view venues, schedules, pricing, events and memberships but not change them. No team management or financial reports.',
  },
  readonly: {
    label: 'Read-only',
    description:
      'View-only access to everything, including financial reports and analytics. Cannot create, change or delete anything — except checking customers in at the door.',
  },
};

/** Whether Circls has `tenant` suspended: it can then be viewed but not changed. */
export function isSuspended(tenant: Pick<Tenant, 'status' | 'isPlatform'> | undefined): boolean {
  return tenant?.status === 'suspended' && !tenant.isPlatform;
}

/** Label for a role value that may come back untyped from the API. */
export function formatRole(role: string): string {
  return ROLE_INFO[role as TenantRole]?.label ?? role;
}

/**
 * The capabilities the portal hides actions behind. The desk ones —
 * `bookings.create` (take a booking, add a registration or a member) and
 * `bookings.cancel` (cancel, and so refund, any of those) — are Staff's too;
 * the rest are setup and administration, for Owners and Managers.
 */
export type PortalCapability =
  | 'bookings.create'
  | 'bookings.cancel'
  | 'events.write'
  | 'memberships.write'
  | 'venues.write'
  | 'arenas.write'
  | 'schedules.write'
  | 'pricing.write'
  | 'members.invite'
  | 'members.role_change'
  | 'members.update'
  | 'members.remove'
  | 'integration.api_keys.manage';

const DESK: readonly PortalCapability[] = ['bookings.create', 'bookings.cancel'];
const ALL: readonly PortalCapability[] = [
  ...DESK,
  'events.write',
  'memberships.write',
  'venues.write',
  'arenas.write',
  'schedules.write',
  'pricing.write',
  'members.invite',
  'members.role_change',
  'members.update',
  'members.remove',
  'integration.api_keys.manage',
];

/**
 * Those capabilities' grants in PARTNER_CAPS (apps/api/src/lib/authz/role_caps.ts).
 * The API enforces them either way; this only keeps the portal from offering
 * what it will refuse.
 */
const ROLE_CAPS: Record<TenantRole, readonly PortalCapability[]> = {
  owner: ALL,
  manager: ALL,
  staff: DESK,
  readonly: [],
};

/**
 * Whether `role` holds `cap`. No role (still loading, or not a member) holds
 * nothing, and nor does one this build doesn't know yet.
 */
export function roleCan(role: TenantRole | null | undefined, cap: PortalCapability): boolean {
  return role != null && (ROLE_CAPS[role]?.includes(cap) ?? false);
}

/**
 * Whether a member holding `actor` may grant `role`, or change or remove a
 * member who holds it: never above their own, so a Manager can't make or
 * unmake an Owner. Mirrors canActOnRole in the API.
 */
export function roleCanActOn(actor: TenantRole | null | undefined, role: TenantRole): boolean {
  if (actor == null || !ROLE_ORDER.includes(actor)) return false;
  return ROLE_ORDER.indexOf(actor) <= ROLE_ORDER.indexOf(role);
}
