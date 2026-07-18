export type TenantRole = 'owner' | 'manager' | 'staff' | 'readonly';

export const ROLE_LABELS: Record<TenantRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'Staff',
  readonly: 'Read-only',
};

/**
 * What each role means on a *partner* tenant — shown when admins inspect a
 * tenant's members. Must stay in sync with PARTNER_CAPS in
 * apps/api/src/lib/authz/role_caps.ts.
 */
export const PARTNER_ROLE_INFO: Record<TenantRole, string> = {
  owner:
    'Full control of the organisation — team, venues, schedules, pricing, bookings, events, financials, refunds, API keys, and deleting the organisation.',
  manager:
    'Everything an Owner can do except delete the organisation.',
  staff:
    'Day-to-day operations — create/cancel bookings, view analytics, answer customer questions. Read-only on venues, schedules, pricing, events and memberships; no team or financial access.',
  readonly:
    'View-only access to everything, including financial reports. Cannot create, change or delete anything.',
};

/**
 * What each role means on the *Circls platform* tenant — shown when accepting
 * an invite to the admin portal. Must stay in sync with PLATFORM_CAPS in
 * apps/api/src/lib/authz/role_caps.ts.
 */
export const PLATFORM_ROLE_INFO: Record<TenantRole, string> = {
  owner:
    'Founder-level access — every admin power plus full management of the Circls organisation and its team.',
  manager:
    'Ops lead — every admin power: suspend or reactivate tenants, review listings, read and execute payouts, manage coupons, handle support, view audit logs. Cannot manage the Circls team.',
  staff:
    'Ops team member — review listings, handle support, and view tenants, payouts, coupons and audit logs. Cannot execute payouts or suspend tenants.',
  readonly:
    'Auditor access — view tenants, payouts, coupons, support and audit logs. Cannot review listings or make any changes.',
};

/** Label for a role value that may come back untyped from the API. */
export function formatRole(role: string): string {
  return ROLE_LABELS[role as TenantRole] ?? role;
}
