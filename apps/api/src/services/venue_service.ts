import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Venue, type VenueOpeningHours, venues } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { getGeocoder, hasGeocodableAddress } from '../lib/geocoding/index.js';
import { canonicalizeCity } from '../lib/geocoding/gazetteer.js';

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
  // Fold alias/case variants of known cities to the canonical spelling
  // ("bangalore" → "Bengaluru") so one city never splits into several in the
  // consumer city filter. Unknown cities pass through as typed.
  const canonicalCity = canonicalizeCity(input.city ?? null, input.country ?? null);
  if (canonicalCity) input = { ...input, city: canonicalCity };
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
    // Canonicalize the effective city (see createVenue) — into both the
    // structured column and the address_json mirror derived below.
    const canonicalCity = canonicalizeCity(eff.city, eff.country);
    if (canonicalCity && canonicalCity !== eff.city) {
      eff.city = canonicalCity;
      set.city = canonicalCity;
    }
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

/**
 * Close a venue: take it off the consumer portal without deleting anything.
 *
 * Closed is the existing `suspended` status. A partner can close from any state
 * — withdrawing a venue still in review, or shelving a rejected one — so the
 * prior status is kept in `status_before_close` for reopening to restore.
 *
 * Existing bookings are untouched: they were paid for, and deciding what to do
 * with them is the partner's call. New online bookings stop, because consumer
 * checkout already refuses a venue that isn't visible.
 *
 * Closing an already-closed venue is a no-op rather than an error, so a retry
 * or a double click can't overwrite the stashed status with `suspended`.
 */
export async function closeVenue(ctx: AuditCtx, venueId: string): Promise<Venue> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(venues)
      .where(and(eq(venues.id, venueId), eq(venues.tenantId, ctx.tenantId)))
      .limit(1)
      .for('update');
    if (!existing) throw new NotFound('Venue not found', 'venue_not_found');
    if (existing.status === 'suspended') return existing;

    const [updated] = await tx
      .update(venues)
      .set({ status: 'suspended', statusBeforeClose: existing.status })
      .where(eq(venues.id, venueId))
      .returning();

    await writeAudit(
      tx,
      ctx,
      'venue.closed',
      'venue',
      venueId,
      { status: existing.status },
      { status: 'suspended' },
    );
    return updated!;
  });
}

/**
 * Reopen a closed venue, back to exactly where it was.
 *
 * A venue that was live comes straight back live. One closed while awaiting
 * review returns to review, and a rejected one stays rejected — reopening must
 * never be a way round Circls review. A venue closed before the prior status
 * was recorded has nothing to restore, so it goes back to review: the one
 * outcome that can't publish something Circls hasn't approved.
 */
export async function reopenVenue(ctx: AuditCtx, venueId: string): Promise<Venue> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(venues)
      .where(and(eq(venues.id, venueId), eq(venues.tenantId, ctx.tenantId)))
      .limit(1)
      .for('update');
    if (!existing) throw new NotFound('Venue not found', 'venue_not_found');
    if (existing.status !== 'suspended') {
      throw new Conflict('Only a closed venue can be reopened', 'venue_not_closed', {
        status: existing.status,
      });
    }

    const restored = existing.statusBeforeClose ?? 'pending_review';
    const [updated] = await tx
      .update(venues)
      .set({ status: restored, statusBeforeClose: null })
      .where(eq(venues.id, venueId))
      .returning();

    await writeAudit(
      tx,
      ctx,
      'venue.reopened',
      'venue',
      venueId,
      { status: 'suspended' },
      { status: restored },
    );
    return updated!;
  });
}

export interface CloseImpact {
  /** Confirmed court bookings that haven't finished yet. */
  upcomingSlotBookings: number;
  /** Live events at the venue that haven't ended. Venue-wide only: events
   *  belong to a venue, not an arena, so an arena close never touches them. */
  upcomingEvents: number;
  /** Confirmed registrations across those events. */
  upcomingEventRegistrations: number;
}

/**
 * What is still booked that closing would affect — for the confirmation a
 * partner reads before closing a venue or one of its arenas.
 *
 * Event registrations are counted separately because the bookings list can't
 * see them: it matches bookings to a time window through their slots, and an
 * event booking has none. Yet closing a venue takes its events off the
 * consumer portal (every public event query requires the venue to be live),
 * so a partner has to be told about them.
 *
 * Callers must have authorised the venue for the requesting tenant.
 */
export async function getCloseImpact(
  tenantId: string,
  venueId: string,
  arenaId?: string,
): Promise<CloseImpact> {
  const arenaClause = arenaId
    ? sql` and (s.arena_id = ${arenaId}::uuid or b.slot_arena_id = ${arenaId}::uuid)`
    : sql``;
  const [slot] = (await db.execute(sql`
    select count(distinct b.id)::int as n
      from bookings b
      left join slots s on s.booking_id = b.id and s.deleted_at is null
     where b.tenant_id = ${tenantId}::uuid
       and b.venue_id = ${venueId}::uuid
       and b.item_type = 'slot'
       and b.status = 'confirmed'
       and coalesce(upper(s.time_range), upper(b.time_range)) > now()${arenaClause}
  `)) as unknown as { n: number }[];

  if (arenaId) {
    return { upcomingSlotBookings: slot?.n ?? 0, upcomingEvents: 0, upcomingEventRegistrations: 0 };
  }

  const [ev] = (await db.execute(sql`
    select count(distinct e.id)::int as events,
           count(b.id)::int          as registrations
      from events e
      left join bookings b on b.item_type = 'event'
                          and b.status = 'confirmed'
                          and b.item_data->>'eventId' = e.id::text
     where e.tenant_id = ${tenantId}::uuid
       and e.venue_id = ${venueId}::uuid
       and e.status = 'published'
       and e.ends_at > now()
  `)) as unknown as { events: number; registrations: number }[];

  return {
    upcomingSlotBookings: slot?.n ?? 0,
    upcomingEvents: ev?.events ?? 0,
    upcomingEventRegistrations: ev?.registrations ?? 0,
  };
}
