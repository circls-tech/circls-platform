import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Venue, venues } from '../db/schema/index.js';
import { NotFound } from '../lib/errors.js';

export interface CreateVenueInput {
  name: string;
  tzName?: string;
  lat?: number | null;
  lng?: number | null;
  addressJson?: Record<string, unknown> | null;
  tags?: string[];
}

export interface UpdateVenueInput {
  name?: string;
  tzName?: string;
  lat?: number | null;
  lng?: number | null;
  addressJson?: Record<string, unknown> | null;
  status?: 'active' | 'suspended';
}

export async function createVenue(tenantId: string, input: CreateVenueInput): Promise<Venue> {
  const [v] = await db
    .insert(venues)
    .values({
      tenantId,
      name: input.name,
      tzName: input.tzName ?? 'Asia/Kolkata',
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      addressJson: input.addressJson ?? null,
      tags: input.tags ?? [],
      // New listings await Circls review before going live (subproject B).
      status: 'pending_review',
    })
    .returning();
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
  if (patch.status !== undefined) set.status = patch.status;

  const [v] = await db
    .update(venues)
    .set(set)
    .where(and(eq(venues.id, venueId), eq(venues.tenantId, tenantId)))
    .returning();
  if (!v) throw new NotFound('Venue not found', 'venue_not_found');
  return v;
}
