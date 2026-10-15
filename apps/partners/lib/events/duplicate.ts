import { emptyTier, tierDraftFromApi, type TierDraft } from '@/components/TiersEditor';
import { maxPerUserFromApi } from '@/components/MaxPerUserField';
import type { PostBookingRedirect, QrTicketConfig, VenueEvent } from '@/lib/api/types';
import { questionDraftFromApi, type QuestionDraft } from './questions';

/** Standalone-address form fields hydrated from an event (as returned by GET). */
export interface AddressDraft {
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  tz: string;
  coords: { lat: number; lng: number } | null;
}

const DEFAULT_TZ = 'Asia/Kolkata';

/**
 * Prefill the standalone address fields from whatever the event carries. The
 * API stores the address under the form's own keys (`pincode`, not
 * `postalCode`), so this is a straight read; anything non-string is blank.
 */
export function addressDraftFromApi(
  ev: Pick<VenueEvent, 'addressJson' | 'lat' | 'lng' | 'tzName'>,
): AddressDraft {
  const addr = (ev.addressJson ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof addr[k] === 'string' ? (addr[k] as string) : '');
  return {
    line1: str('line1'),
    line2: str('line2'),
    city: str('city'),
    state: str('state'),
    pincode: str('pincode'),
    country: str('country'),
    tz: ev.tzName ?? DEFAULT_TZ,
    coords: ev.lat != null && ev.lng != null ? { lat: ev.lat, lng: ev.lng } : null,
  };
}

/** What the create form seeds when opened as a copy of an existing event. */
export interface DuplicateDraft {
  scope: 'venue' | 'standalone';
  venueId: string;
  address: AddressDraft;
  name: string;
  description: string;
  tiers: TierDraft[];
  questions: QuestionDraft[];
  maxPerUser: string | null;
  qrConfig: QrTicketConfig | null;
  redirect: PostBookingRedirect | null;
}

/**
 * Everything a copy inherits from its source event. Dates, recurrence and
 * photos are deliberately left out: rerunning a finished event is the common
 * case, so the copy must never carry the original's dates, and photos are
 * re-added from the form or the copy's own page.
 */
export function duplicateDraftFromEvent(source: VenueEvent): DuplicateDraft {
  return {
    scope: source.venueId ? 'venue' : 'standalone',
    venueId: source.venueId ?? '',
    address: addressDraftFromApi(source),
    name: source.name,
    description: source.description ?? '',
    // Live tier ids are dropped: a copy gets tiers of its own.
    tiers:
      source.tiers.length > 0
        ? source.tiers.map(({ id: _id, ...t }) => tierDraftFromApi(t))
        : [emptyTier()],
    questions: (source.questions ?? []).map(questionDraftFromApi),
    maxPerUser: maxPerUserFromApi(source.maxPerUser),
    qrConfig: source.qrTicketConfig,
    redirect: source.postBookingRedirect,
  };
}
