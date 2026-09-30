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
 *
 * Each map below is a `Record` over the whole status union rather than a set
 * of the off-shelf ones, so adding a status to a union is a compile error here
 * until someone says which shelf it belongs on. A set would have accepted the
 * new value silently and shown it among what is selling.
 */

/** `true` = on shelf. */
const VENUE_SHELF: Record<ListingStatus, boolean> = {
  pending_review: true,
  active: true,
  rejected: false,
  suspended: false,
  inactive: false,
};

/**
 * `completed` stays on shelf: it ran, and its guest list still matters for a
 * while afterwards. Only what was pulled before it could run comes off.
 */
const EVENT_SHELF: Record<EventStatus, boolean> = {
  draft: true,
  pending_review: true,
  published: true,
  completed: true,
  cancelled: false,
  rejected: false,
};

const MEMBERSHIP_SHELF: Record<Membership['status'], boolean> = {
  pending_review: true,
  active: true,
  inactive: false,
  rejected: false,
  suspended: false,
};

export const isVenueOnShelf = (v: { status: ListingStatus }): boolean => VENUE_SHELF[v.status];

export const isEventOnShelf = (e: { status: EventStatus }): boolean => EVENT_SHELF[e.status];

export const isMembershipOnShelf = (m: { status: Membership['status'] }): boolean =>
  MEMBERSHIP_SHELF[m.status];
