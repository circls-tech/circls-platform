import { env } from '../config/env.js';
import {
  publicEventIdsAmong,
  publicMembershipIdsAmong,
  publicVenueIdsAmong,
} from './consumer_service.js';
import { previewPath, type PreviewType } from './listing_preview_service.js';

/**
 * Links from the admin console to listings' pages on the consumer site.
 *
 * Only a listing customers can open right now gets one, decided by
 * consumer_service's own visibility gate — approved, the organiser active and
 * listed, an active venue if it has one, and for an event not yet ended — so
 * a link never lands on "not found". Asking that gate rather than restating
 * it keeps the two from drifting.
 */
const PUBLIC_IDS: Record<PreviewType, (ids: string[]) => Promise<Set<string>>> = {
  event: publicEventIdsAmong,
  venue: publicVenueIdsAmong,
  membership: publicMembershipIdsAmong,
};

/** The consumer-site URL of each of `ids` customers can open; the rest are absent. */
export async function consumerLinks(type: PreviewType, ids: string[]): Promise<Map<string, string>> {
  const visible = await PUBLIC_IDS[type](ids);
  return new Map(
    [...visible].map((id) => [id, new URL(previewPath(type, id), env.CONSUMER_BASE_URL).toString()]),
  );
}
