import type { EventStatus, ListingStatus, Membership } from '@/lib/api/types';

/**
 * What is "off shelf": withdrawn from sale, and not on its way back by itself.
 *
 * Nothing off shelf appears on the consumer portal, so it has no place on a
 * surface meant for what a partner is running right now — the dashboard, and
 * the default tab of each list page. The full lists keep it reachable.
 *
 * `pending_review` and an event's `draft` stay ON shelf on purpose: both are
 * headed for live and the partner is still working on them, so hiding them
 * would bury the thing a new partner is in the middle of setting up.
 */
export const OFF_SHELF_VENUE: ReadonlySet<ListingStatus> = new Set(['suspended', 'rejected']);

/**
 * `completed` stays on shelf: it ran, and its guest list still matters for a
 * while afterwards. Only what was pulled before it could run comes off.
 */
export const OFF_SHELF_EVENT: ReadonlySet<EventStatus> = new Set(['cancelled', 'rejected']);

export const OFF_SHELF_MEMBERSHIP: ReadonlySet<Membership['status']> = new Set([
  'inactive',
  'rejected',
]);

export const isVenueOnShelf = (v: { status: ListingStatus }): boolean => !OFF_SHELF_VENUE.has(v.status);

export const isEventOnShelf = (e: { status: EventStatus }): boolean => !OFF_SHELF_EVENT.has(e.status);

export const isMembershipOnShelf = (m: { status: Membership['status'] }): boolean =>
  !OFF_SHELF_MEMBERSHIP.has(m.status);
