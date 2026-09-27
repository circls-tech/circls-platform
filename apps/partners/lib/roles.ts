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
      'View-only access to everything except API keys and webhooks — financial reports and analytics included. Cannot create, change or delete anything, apart from checking customers in at the door.',
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
 * The capabilities the portal gates controls on. The desk ones —
 * `bookings.create` (take a booking, add a registration or a member) and
 * `bookings.cancel` (cancel, and so refund, any of those) — are Staff's too,
 * as is answering customers; the rest are setup and administration, for
 * Owners and Managers. The type is derived from this list, so a capability
 * can't be added to one and forgotten in the other.
 */
const DESK = ['bookings.create', 'bookings.cancel'] as const;
const ALL = [
  ...DESK,
  'questions.write',
  'events.write',
  'memberships.write',
  'venues.write',
  'arenas.write',
  'schedules.write',
  'pricing.write',
  'discounts.write',
  'tenant.update',
  'members.invite',
  'members.role_change',
  'members.update',
  'members.remove',
  'integration.read',
  'integration.api_keys.manage',
] as const;
export type PortalCapability = (typeof ALL)[number];

/**
 * Those capabilities' grants in PARTNER_CAPS and, for the Circls team's own
 * organisation, PLATFORM_CAPS (apps/api/src/lib/authz/role_caps.ts). The API
 * enforces them either way; this only keeps the portal from offering what it
 * will refuse.
 */
const PARTNER_ROLE_CAPS: Record<TenantRole, readonly PortalCapability[]> = {
  owner: ALL,
  manager: ALL,
  staff: [...DESK, 'questions.write'],
  readonly: [],
};
const PLATFORM_ROLE_CAPS: Record<TenantRole, readonly PortalCapability[]> = {
  owner: ALL,
  manager: ['tenant.update', 'integration.read', 'integration.api_keys.manage'],
  staff: [],
  readonly: [],
};

/**
 * Whether `role` holds `cap` — on a partner organisation, or on the Circls
 * platform one with `isPlatform`. No role (still loading, or not a member)
 * holds nothing, and nor does one this build doesn't know yet.
 */
export function roleCan(
  role: TenantRole | null | undefined,
  cap: PortalCapability,
  { isPlatform = false }: { isPlatform?: boolean | undefined } = {},
): boolean {
  if (role == null) return false;
  const grants = isPlatform ? PLATFORM_ROLE_CAPS : PARTNER_ROLE_CAPS;
  return grants[role]?.includes(cap) ?? false;
}

/**
 * Whether the signed-in member may use `cap` in `tenant` (a /v1/me/tenants
 * row, which carries their role): their role's grant, of which a suspended
 * organisation keeps only the read capabilities. Mirrors can() in the API.
 */
export function tenantCan(
  tenant: Pick<Tenant, 'status' | 'isPlatform' | 'myRole'> | undefined,
  cap: PortalCapability,
): boolean {
  if (!tenant) return false;
  if (isSuspended(tenant) && !cap.endsWith('.read')) return false;
  return roleCan(tenant.myRole, cap, { isPlatform: tenant.isPlatform });
}

/**
 * Whether a member holding `actor` may grant `role`, or change, rename or
 * remove a member who holds it: never above their own, so a Manager can't
 * make or unmake an Owner. Mirrors canActOnRole in the API.
 */
export function roleCanActOn(actor: TenantRole | null | undefined, role: TenantRole): boolean {
  if (actor == null || !ROLE_ORDER.includes(actor)) return false;
  return ROLE_ORDER.indexOf(actor) <= ROLE_ORDER.indexOf(role);
}
