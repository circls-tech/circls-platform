import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Venue, type VenueOpeningHours, venues } from '../db/schema/index.js';
import { NotFound } from '../lib/errors.js';

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

  const [v] = await db
    .update(venues)
    .set(set)
    .where(and(eq(venues.id, venueId), eq(venues.tenantId, tenantId)))
    .returning();
  if (!v) throw new NotFound('Venue not found', 'venue_not_found');
  return v;
}
