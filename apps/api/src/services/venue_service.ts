import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Venue, type VenueOpeningHours, venues } from '../db/schema/index.js';
import { NotFound } from '../lib/errors.js';
import { getGeocoder, hasGeocodableAddress } from '../lib/geocoding/index.js';

/** Trust-metadata fields shared by create + update (PR #109). */
export interface VenueMetadataInput {
  description?: string | null;
  amenities?: string[];
  openingHours?: VenueOpeningHours | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface CreateVenueInput extends VenueMetadataInput {
  name: string;
  tzName?: string;
  lat?: number | null;
  lng?: number | null;
  addressJson?: Record<string, unknown> | null;
  tags?: string[];
}

export interface UpdateVenueInput extends VenueMetadataInput {
  name?: string;
  tzName?: string;
  lat?: number | null;
  lng?: number | null;
  addressJson?: Record<string, unknown> | null;
  tags?: string[];
  status?: 'active' | 'suspended';
}

/** Copy trust-metadata fields that were explicitly provided onto a values/set object. */
function applyMetadata(target: Partial<typeof venues.$inferInsert>, input: VenueMetadataInput): void {
  if (input.description !== undefined) target.description = input.description;
  if (input.amenities !== undefined) target.amenities = input.amenities;
  if (input.openingHours !== undefined) target.openingHours = input.openingHours;
  if (input.contactPhone !== undefined) target.contactPhone = input.contactPhone;
  if (input.contactEmail !== undefined) target.contactEmail = input.contactEmail;
  if (input.addressLine1 !== undefined) target.addressLine1 = input.addressLine1;
  if (input.addressLine2 !== undefined) target.addressLine2 = input.addressLine2;
  if (input.city !== undefined) target.city = input.city;
  if (input.state !== undefined) target.state = input.state;
  if (input.postalCode !== undefined) target.postalCode = input.postalCode;
  if (input.country !== undefined) target.country = input.country;
}

/** The structured postal-address fields, resolved to their effective values. */
interface EffectiveAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

/** The postal-address column names — the trigger set for re-mirroring + geocoding. */
const ADDRESS_FIELDS = ['addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country'] as const;

/**
 * Mirror the structured address into the freeform `address_json` blob. The
 * consumer surface reads city/country off `address_json` (and events copy their
 * venue's `address_json`), while partners edit the structured columns — this
 * keeps the two in sync so a partner-entered "City, Country" actually drives
 * consumer location filtering. Returns null when no address parts are set.
 */
function composeAddressJson(a: EffectiveAddress): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (a.line1) out.line1 = a.line1;
  if (a.line2) out.line2 = a.line2;
  if (a.city) out.city = a.city;
  if (a.state) out.state = a.state;
  if (a.postalCode) out.postalCode = a.postalCode;
  if (a.country) out.country = a.country;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * When an address is present and the caller didn't hand-set coordinates, derive
 * lat/lng from the address (best-effort — a null geocode leaves `set` untouched
 * so we never clobber good coordinates with nothing) and mirror the structured
 * address into `address_json`. Mutates `set` in place.
 */
async function applyAddressDerivation(
  set: Partial<typeof venues.$inferInsert>,
  eff: EffectiveAddress,
  explicit: {
    lat?: number | null | undefined;
    lng?: number | null | undefined;
    addressJson?: Record<string, unknown> | null | undefined;
  },
): Promise<void> {
  // Keep address_json a faithful mirror unless the caller passed one explicitly.
  if (explicit.addressJson === undefined) set.addressJson = composeAddressJson(eff);

  // Only geocode when the caller left coordinates to us and there's something to resolve.
  if (explicit.lat === undefined && explicit.lng === undefined && hasGeocodableAddress(eff)) {
    const point = await getGeocoder().geocode(eff);
    if (point) {
      set.lat = point.lat;
      set.lng = point.lng;
    }
  }
}

export async function createVenue(tenantId: string, input: CreateVenueInput): Promise<Venue> {
  const values: typeof venues.$inferInsert = {
    tenantId,
    name: input.name,
    tzName: input.tzName ?? 'Asia/Kolkata',
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    addressJson: input.addressJson ?? null,
    tags: input.tags ?? [],
    // New listings await Circls review before going live (subproject B).
    status: 'pending_review',
  };
  applyMetadata(values, input);
  // Derive coordinates + mirror address_json from whatever address was supplied.
  await applyAddressDerivation(
    values,
    {
      line1: input.addressLine1 ?? null,
      line2: input.addressLine2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
    },
    { lat: input.lat, lng: input.lng, addressJson: input.addressJson },
  );
  const [v] = await db.insert(venues).values(values).returning();
  if (!v) throw new Error('venue insert returned no row');
  return v;
}

export async function listVenues(tenantId: string): Promise<Venue[]> {
  return db.select().from(venues).where(eq(venues.tenantId, tenantId));
}

/** Unscoped lookup — callers must then assert tenant membership on venue.tenantId. */
export async function getVenueById(venueId: string): Promise<Venue | undefined> {
  return db.query.venues.findFirst({ where: eq(venues.id, venueId) });
}

export async function updateVenue(
  tenantId: string,
  venueId: string,
  patch: UpdateVenueInput,
): Promise<Venue> {
  const set: Partial<typeof venues.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.tzName !== undefined) set.tzName = patch.tzName;
  if (patch.lat !== undefined) set.lat = patch.lat;
  if (patch.lng !== undefined) set.lng = patch.lng;
  if (patch.addressJson !== undefined) set.addressJson = patch.addressJson;
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.status !== undefined) set.status = patch.status;
  applyMetadata(set, patch);

  // When the postal address is touched, re-mirror address_json and re-derive
  // coordinates from the effective (current-overlaid-by-patch) address.
  if (ADDRESS_FIELDS.some((f) => patch[f] !== undefined)) {
    const current = await db.query.venues.findFirst({
      where: and(eq(venues.id, venueId), eq(venues.tenantId, tenantId)),
    });
    if (!current) throw new NotFound('Venue not found', 'venue_not_found');
    const pick = <K extends keyof Venue>(patchVal: unknown, col: K): Venue[K] =>
      (patchVal !== undefined ? patchVal : current[col]) as Venue[K];
    const eff: EffectiveAddress = {
      line1: pick(patch.addressLine1, 'addressLine1'),
      line2: pick(patch.addressLine2, 'addressLine2'),
      city: pick(patch.city, 'city'),
      state: pick(patch.state, 'state'),
      postalCode: pick(patch.postalCode, 'postalCode'),
      country: pick(patch.country, 'country'),
    };
    await applyAddressDerivation(set, eff, {
      lat: patch.lat,
      lng: patch.lng,
      addressJson: patch.addressJson,
    });
  }

  const [v] = await db
    .update(venues)
    .set(set)
    .where(and(eq(venues.id, venueId), eq(venues.tenantId, tenantId)))
    .returning();
  if (!v) throw new NotFound('Venue not found', 'venue_not_found');
  return v;
}
