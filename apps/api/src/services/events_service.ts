/**
 * Events service — Phase 15 (venue-scoped, subproject C).
 *
 * An event is a venue-level offering during a single window (no arena binding —
 * the `event_arenas` join was dropped in C). Booking an event creates
 * `bookings` rows with `item_type='event'`; capacity is enforced at service
 * level (events are seat-based, not slot-based) and is independent of arena slot
 * inventory.
 *
 * Authz: routes resolve and assert the actor's tenant membership before reaching
 * this layer.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { events, type Event, type NewEvent } from '../db/schema/events.js';
import { eventTicketTiers } from '../db/schema/event_ticket_tiers.js';
import type { QrTicketConfig } from '../db/schema/qr_ticket_config.js';
import { revokeQrTicketsForEvent } from './qr_ticket_service.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import {
  getGeocoder,
  hasGeocodableAddress,
  type GeocodeQuery,
  type GeoPoint,
} from '../lib/geocoding/index.js';
import { canonicalizeCity } from '../lib/geocoding/gazetteer.js';
import {
  applyLiveTiers,
  listTiersWithRemaining,
  replaceTiers,
  type TierInput,
} from './event_tiers_service.js';
import {
  listQuestions,
  replaceQuestions,
  type RegistrationQuestionInput,
} from './event_registration_questions_service.js';

export interface EventBookingTicketLine {
  tierName: string;
  quantity: number;
}

export interface EventBookingAnswerLine {
  questionId: string;
  /** Question label as it read at booking time. */
  label: string;
  answer: string;
}

export interface EventBookingRow {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  status: string;
  totalPaise: number;
  createdAt: string;
  /** Ticket lines (tier name + quantity), in tier sort order. */
  tickets: EventBookingTicketLine[];
  /** Registration-question answers, in question sort order. */
  answers: EventBookingAnswerLine[];
}

/**
 * Registrations for an event (partner-facing). Event bookings live in the
 * `bookings` table with item_type='event' and item_data->>'eventId' = the id —
 * they don't appear in the slot/time-window bookings grid, so this is their
 * dedicated read.
 *
 * Email/phone come from the linked user account when the booking has one;
 * otherwise the free-text `customer_contact` is classified into whichever
 * column it resembles so exports still carry the contact.
 */
export async function listEventBookings(
  tenantId: string,
  eventId: string,
): Promise<EventBookingRow[]> {
  const raw = await db.execute<Record<string, unknown>>(sql`
    select b.id, b.customer_name, b.customer_contact, b.status, b.total_paise, b.created_at,
           u.display_name as user_display_name, u.email as user_email, u.phone_e164 as user_phone,
           coalesce(t.tickets, '[]'::json)::text as tickets,
           coalesce(ans.answers, '[]'::json)::text as answers
    from bookings b
    left join users u on u.id = b.customer_user_id
    left join (
      select ebt.booking_id,
             json_agg(json_build_object('tierName', tt.name, 'quantity', ebt.quantity)
                      order by tt.sort_order, tt.name) as tickets
      from event_booking_tickets ebt
      join event_ticket_tiers tt on tt.id = ebt.tier_id
      group by ebt.booking_id
    ) t on t.booking_id = b.id
    left join (
      select era.booking_id,
             json_agg(json_build_object('questionId', era.question_id, 'label', era.question_label,
                                        'answer', era.answer)
                      order by q.sort_order, era.created_at) as answers
      from event_registration_answers era
      left join event_registration_questions q on q.id = era.question_id
      group by era.booking_id
    ) ans on ans.booking_id = b.id
    where b.tenant_id = ${tenantId}
      and b.item_type = 'event'
      and b.item_data->>'eventId' = ${eventId}
    order by b.created_at desc
    limit 500
  `);
  const rows = raw as unknown as Record<string, unknown>[];
  return rows.map((r) => {
    const contact = (r['customer_contact'] as string | null) ?? null;
    const contactIsEmail = contact !== null && contact.includes('@');
    return {
      id: r['id'] as string,
      customerName:
        (r['customer_name'] as string | null) ?? (r['user_display_name'] as string | null) ?? null,
      customerContact: contact,
      customerEmail: (r['user_email'] as string | null) ?? (contactIsEmail ? contact : null),
      customerPhone: (r['user_phone'] as string | null) ?? (!contactIsEmail ? contact : null),
      status: r['status'] as string,
      totalPaise: Number(r['total_paise']),
      createdAt: new Date(r['created_at'] as string).toISOString(),
      tickets: JSON.parse(r['tickets'] as string) as EventBookingTicketLine[],
      answers: JSON.parse(r['answers'] as string) as EventBookingAnswerLine[],
    };
  });
}

export async function listEventsForVenue(venueId: string): Promise<Event[]> {
  return db.select().from(events).where(eq(events.venueId, venueId));
}

/** All events for a tenant (venue-scoped + org-scoped), newest first. */
export async function listEventsForTenant(tenantId: string): Promise<Event[]> {
  return db
    .select()
    .from(events)
    .where(eq(events.tenantId, tenantId))
    .orderBy(sql`${events.createdAt} desc`);
}

export async function getEvent(
  eventId: string,
  tenantId: string,
): Promise<
  | (Event & {
      tiers: Awaited<ReturnType<typeof listTiersWithRemaining>>;
      questions: Awaited<ReturnType<typeof listQuestions>>;
    })
  | null
> {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;
  const tiers = await listTiersWithRemaining(db, eventId);
  const questions = await listQuestions(db, eventId);
  return { ...row, tiers, questions };
}

/** Unscoped lookup — callers must then assert tenant membership on event.tenantId. */
export async function getEventById(eventId: string): Promise<Event | null> {
  const [row] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  return row ?? null;
}

export interface CreateEventInput {
  tenantId: string;
  /** Omit for an org-scoped (venue-less) event. */
  venueId?: string | undefined;
  /** Standalone location — required when venueId is omitted. */
  addressJson?: Record<string, unknown> | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  tzName?: string | undefined;
  name: string;
  description?: string | undefined;
  startsAt: Date;
  endsAt: Date;
  /** Legacy: set by replaceTiers to the minimum tier price. Default 0. */
  pricePaise?: number | undefined;
  capacity?: number | undefined;
  /** Per-customer ticket cap for the whole event (all tiers); null/omitted = no limit. */
  maxPerUser?: number | null | undefined;
  tiers: TierInput[];
  /** Custom registration questions consumers answer at booking; [] / omitted = none. */
  questions?: RegistrationQuestionInput[] | undefined;
  /** QR entry-ticket rules (null/omitted = disabled). */
  qrTicketConfig?: QrTicketConfig | null | undefined;
}

/**
 * Map an event's freeform address_json to a geocode query. Events store the
 * postal code under `pincode` (the form's label), not `postalCode`.
 */
function toGeocodeQuery(addressJson: Record<string, unknown>): GeocodeQuery {
  const str = (k: string) =>
    typeof addressJson[k] === 'string' ? (addressJson[k] as string) : null;
  return {
    line1: str('line1'),
    city: str('city'),
    state: str('state'),
    postalCode: str('pincode'),
    country: str('country'),
  };
}

/**
 * Derive lat/lng for standalone inputs whose caller left coordinates unset —
 * the events counterpart of the venue flow's applyAddressDerivation (organisers
 * never hand-enter coordinates). Best-effort: a failed geocode leaves the
 * coordinates unset and never fails the create. `cache` dedupes identical
 * addresses so a recurring series geocodes each distinct address once, not once
 * per occurrence. Mutates the inputs in place; call before opening a
 * transaction (this may go to the network).
 */
async function deriveStandaloneCoords(
  inputs: CreateEventInput[],
  cache = new Map<string, GeoPoint | null>(),
): Promise<void> {
  for (const input of inputs) {
    if (input.venueId || input.lat !== undefined || input.lng !== undefined) continue;
    if (!input.addressJson) continue;
    const query = toGeocodeQuery(input.addressJson);
    if (!hasGeocodableAddress(query)) continue;
    const key = JSON.stringify(query);
    let point = cache.get(key);
    if (point === undefined) {
      point = await getGeocoder().geocode(query);
      cache.set(key, point);
    }
    if (point) {
      input.lat = point.lat;
      input.lng = point.lng;
    }
  }
}

/**
 * Fold a standalone address's city to its canonical gazetteer spelling
 * ("bangalore" → "Bengaluru") so one city never splits into several in the
 * consumer city filter. Unknown cities pass through as typed. Returns the same
 * object when nothing changes.
 */
function canonicalizeAddressJsonCity(
  addressJson: Record<string, unknown>,
): Record<string, unknown> {
  const city = typeof addressJson.city === 'string' ? addressJson.city : null;
  const country = typeof addressJson.country === 'string' ? addressJson.country : null;
  const canonical = canonicalizeCity(city, country);
  return canonical && canonical !== city ? { ...addressJson, city: canonical } : addressJson;
}

/** `canonicalizeAddressJsonCity` over every standalone input, in place. */
function canonicalizeStandaloneCities(inputs: CreateEventInput[]): void {
  for (const input of inputs) {
    if (!input.venueId && input.addressJson) {
      input.addressJson = canonicalizeAddressJsonCity(input.addressJson);
    }
  }
}

function validateCreateEventInput(input: CreateEventInput): void {
  if (input.startsAt >= input.endsAt) {
    throw new BadRequest('startsAt must be before endsAt', 'invalid_event_window');
  }
  if (!input.venueId) {
    if (!input.addressJson) {
      throw new BadRequest('Org-scoped events require an address', 'event_address_required');
    }
    if (!input.tzName) {
      throw new BadRequest('Org-scoped events require a timezone', 'event_tz_required');
    }
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertEventTx(
  tx: Tx,
  ctx: AuditCtx,
  input: CreateEventInput,
  seriesId: string | null,
): Promise<Event> {
  const isStandalone = !input.venueId;
  const [row] = await tx
    .insert(events)
    .values({
      tenantId: input.tenantId,
      venueId: input.venueId ?? null,
      addressJson: isStandalone ? (input.addressJson ?? null) : null,
      lat: isStandalone ? (input.lat ?? null) : null,
      lng: isStandalone ? (input.lng ?? null) : null,
      tzName: isStandalone ? (input.tzName ?? null) : null,
      name: input.name,
      description: input.description ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      pricePaise: input.pricePaise ?? 0,
      capacity: input.capacity ?? null,
      maxPerUser: input.maxPerUser ?? null,
      qrTicketConfig: input.qrTicketConfig ?? null,
      seriesId,
      status: 'draft',
    })
    .returning();
  if (!row) throw new Error('event insert returned no row');

  await replaceTiers(tx, row.id, input.tenantId, input.tiers);
  await replaceQuestions(tx, row.id, input.tenantId, input.questions ?? []);

  await writeAudit(tx, ctx, 'event.created', 'event', row.id, null, {
    venueId: row.venueId,
    isStandalone,
    name: row.name,
    pricePaise: row.pricePaise,
    ...(seriesId ? { seriesId } : {}),
  });

  return row;
}

/**
 * Create a draft Event. Venue-scoped when `venueId` is given (location read from
 * the venue); org-scoped when omitted, in which case `addressJson` + `tzName`
 * are required and stored on the event. Validates startsAt < endsAt.
 */
export async function createEvent(ctx: AuditCtx, input: CreateEventInput): Promise<Event> {
  validateCreateEventInput(input);
  canonicalizeStandaloneCities([input]);
  await deriveStandaloneCoords([input]);
  return db.transaction(async (tx) => insertEventTx(tx, ctx, input, null));
}

/** Hard cap on occurrences created per series (a year of twice-weekly dates). */
export const MAX_SERIES_OCCURRENCES = 104;

/**
 * Create a recurring event: one draft Event per occurrence, all sharing a fresh
 * series_id, atomically. Each occurrence is a complete CreateEventInput (the
 * route resolves base fields + per-date overrides), so dates may differ in
 * venue/address, window, and tiers. Returns the created rows sorted by start.
 */
export async function createEventSeries(
  ctx: AuditCtx,
  occurrences: CreateEventInput[],
): Promise<Event[]> {
  if (occurrences.length < 2) {
    throw new BadRequest('A series needs at least 2 occurrences', 'series_too_small');
  }
  if (occurrences.length > MAX_SERIES_OCCURRENCES) {
    throw new BadRequest(
      `A series can have at most ${MAX_SERIES_OCCURRENCES} occurrences`,
      'series_too_large',
    );
  }
  for (const occ of occurrences) validateCreateEventInput(occ);
  canonicalizeStandaloneCities(occurrences);
  await deriveStandaloneCoords(occurrences);

  const seriesId = randomUUID();
  const sorted = [...occurrences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return db.transaction(async (tx) => {
    const rows: Event[] = [];
    for (const occ of sorted) {
      rows.push(await insertEventTx(tx, ctx, occ, seriesId));
    }
    return rows;
  });
}

/** All occurrences of a series owned by the tenant, soonest first. */
export async function listSeriesEvents(tenantId: string, seriesId: string): Promise<Event[]> {
  return db
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.seriesId, seriesId)))
    .orderBy(sql`${events.startsAt} asc`);
}

/**
 * Submit every draft occurrence of a series for review (draft → pending_review)
 * in one transaction. 404 if the tenant owns no such series; 409 if none of its
 * occurrences are still drafts.
 */
export async function publishEventSeries(ctx: AuditCtx, seriesId: string): Promise<Event[]> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(events)
      .where(and(eq(events.tenantId, ctx.tenantId), eq(events.seriesId, seriesId)));
    if (existing.length === 0) throw new NotFound('Series not found', 'series_not_found');
    const drafts = existing.filter((e) => e.status === 'draft');
    if (drafts.length === 0) {
      throw new Conflict('No draft occurrences left to submit', 'event_not_draft');
    }

    const updated: Event[] = [];
    for (const ev of drafts) {
      const [row] = await tx
        .update(events)
        .set({ status: 'pending_review' })
        .where(eq(events.id, ev.id))
        .returning();
      updated.push(row!);
      await writeAudit(
        tx,
        ctx,
        'event.submitted_for_review',
        'event',
        ev.id,
        { status: 'draft' },
        { status: 'pending_review', seriesId },
      );
    }
    return updated;
  });
}

/**
 * Cancel every non-terminal occurrence of a series (draft/pending_review/
 * published → cancelled) in one transaction, revoking QR tickets per event.
 */
export async function cancelEventSeries(ctx: AuditCtx, seriesId: string): Promise<Event[]> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(events)
      .where(and(eq(events.tenantId, ctx.tenantId), eq(events.seriesId, seriesId)));
    if (existing.length === 0) throw new NotFound('Series not found', 'series_not_found');
    const cancellable = existing.filter(
      (e) => e.status !== 'cancelled' && e.status !== 'rejected',
    );
    if (cancellable.length === 0) {
      throw new Conflict('No occurrences left to cancel', 'event_not_cancellable');
    }

    const updated: Event[] = [];
    for (const ev of cancellable) {
      const [row] = await tx
        .update(events)
        .set({ status: 'cancelled' })
        .where(eq(events.id, ev.id))
        .returning();
      updated.push(row!);
      await revokeQrTicketsForEvent(ev.id, tx);
      await writeAudit(
        tx,
        ctx,
        'event.cancelled',
        'event',
        ev.id,
        { status: ev.status },
        { status: 'cancelled', seriesId },
      );
    }
    return updated;
  });
}

export interface UpdateEventPatch {
  name?: string;
  description?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  // Price + capacity are no longer set directly: an event's price is derived
  // from its ticket tiers (events.price_paise is kept in sync as the min tier
  // price by replaceTiers), and capacity is per-tier. Edit via `tiers` below.
  /**
   * Re-scope the event. A venue id makes it venue-scoped (location is read from
   * the venue, so the denormalized standalone fields are cleared). `null` makes
   * it standalone, using `addressJson`/`tzName` below (falling back to whatever
   * the event already carries). Omit to leave the scope unchanged. The caller
   * (route) is responsible for verifying the venue belongs to the tenant.
   */
  venueId?: string | null;
  /** Standalone address — applied when the event is (or becomes) standalone. */
  addressJson?: Record<string, unknown>;
  tzName?: string;
  lat?: number | null;
  lng?: number | null;
  /** null clears (QR tickets off); omitted = unchanged. */
  qrTicketConfig?: QrTicketConfig | null;
  /** Per-customer ticket cap for the whole event; null clears, omitted = unchanged. */
  maxPerUser?: number | null;
  /** When provided, replaces all ticket tiers (draft-only). */
  tiers?: TierInput[];
  /** When provided, replaces all registration questions (draft-only; [] clears). */
  questions?: RegistrationQuestionInput[];
  /**
   * Published-only: raise individual tiers' capacity by id. A capped tier can
   * go higher or become unlimited (null); never lower, and an unlimited tier
   * can't become capped — so tickets already sold are never invalidated.
   * Draft events edit capacity through `tiers` instead.
   */
  tierCapacities?: { tierId: string; capacity: number | null }[];
}

/** The patch fields a PUBLISHED event may change freely; name/window/location/
 *  tiers go through the admin-approved change-request flow instead. */
const LIVE_EDITABLE_KEYS = new Set([
  'maxPerUser',
  'tierCapacities',
  'description',
  'qrTicketConfig',
  'questions',
]);

/**
 * Unconstrained-on-approval-free fields for a published event: the
 * per-customer ticket cap (any change — it only gates future purchases, never
 * existing tickets), increase-only tier capacity, description, QR ticket
 * config, and registration questions (replace-all, like drafts). Any other
 * field is rejected — name/window/location/tiers change only via an approved
 * change request, so the content the circls team reviewed stays controlled.
 */
async function applyLiveSettings(
  tx: Tx,
  ctx: AuditCtx,
  existing: Event,
  patch: UpdateEventPatch,
): Promise<Event> {
  const disallowed = Object.entries(patch)
    .filter(([k, v]) => v !== undefined && !LIVE_EDITABLE_KEYS.has(k))
    .map(([k]) => k);
  if (disallowed.length > 0) {
    throw new Conflict(
      `These fields need an approved change request on a live event: ${disallowed.join(', ')}. Freely editable: description, QR config, questions, per-customer limit, capacity increases.`,
      'event_not_draft',
      { fields: disallowed },
    );
  }

  const capacityBefore: Record<string, number | null> = {};
  if (patch.tierCapacities !== undefined) {
    const tiers = await tx
      .select()
      .from(eventTicketTiers)
      .where(and(eq(eventTicketTiers.eventId, existing.id), isNull(eventTicketTiers.deletedAt)));
    const byId = new Map(tiers.map((t) => [t.id, t]));
    for (const { tierId, capacity } of patch.tierCapacities) {
      const tier = byId.get(tierId);
      if (!tier) throw new BadRequest('Unknown ticket tier for this event', 'bad_request');
      // Increase-only (equal = idempotent no-op): unlimited can't shrink to a
      // cap, and a cap can only rise or lift to unlimited.
      const decreases = capacity !== null && (tier.capacity === null || capacity < tier.capacity);
      if (decreases) {
        throw new BadRequest(
          'Capacity can only be increased on a live event',
          'event_capacity_decrease',
          { tierId, current: tier.capacity, requested: capacity },
        );
      }
      if (capacity !== tier.capacity) {
        capacityBefore[tierId] = tier.capacity;
        await tx.update(eventTicketTiers).set({ capacity }).where(eq(eventTicketTiers.id, tierId));
      }
    }
  }

  const set: Partial<NewEvent> = {};
  if (patch.maxPerUser !== undefined) set.maxPerUser = patch.maxPerUser;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.qrTicketConfig !== undefined) set.qrTicketConfig = patch.qrTicketConfig;
  if (Object.keys(set).length > 0) {
    await tx.update(events).set(set).where(eq(events.id, existing.id));
  }

  if (patch.questions !== undefined) {
    await replaceQuestions(tx, existing.id, ctx.tenantId, patch.questions);
  }

  const [updated] = await tx.select().from(events).where(eq(events.id, existing.id)).limit(1);

  await writeAudit(
    tx,
    ctx,
    'event.live_settings_updated',
    'event',
    existing.id,
    {
      maxPerUser: existing.maxPerUser,
      capacities: capacityBefore,
      ...(patch.description !== undefined ? { description: existing.description } : {}),
      ...(patch.qrTicketConfig !== undefined ? { qrTicketConfig: existing.qrTicketConfig } : {}),
    },
    {
      ...(patch.maxPerUser !== undefined ? { maxPerUser: patch.maxPerUser } : {}),
      ...(patch.tierCapacities !== undefined ? { tierCapacities: patch.tierCapacities } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.qrTicketConfig !== undefined ? { qrTicketConfig: patch.qrTicketConfig } : {}),
      ...(patch.questions !== undefined ? { questions: patch.questions } : {}),
    },
  );

  return updated!;
}

/**
 * Pre-transaction patch normalization shared by draft edits and approved
 * change requests: canonicalize the typed city to the gazetteer spelling, and
 * re-derive the map pin from a new address when coordinates weren't hand-set
 * (outside the tx — geocoding may go to the network). A null geocode leaves
 * lat/lng out of the patch so existing coordinates survive.
 */
export async function prepareEventPatch(patch: UpdateEventPatch): Promise<UpdateEventPatch> {
  if (patch.addressJson !== undefined) {
    patch = { ...patch, addressJson: canonicalizeAddressJsonCity(patch.addressJson) };
  }
  if (patch.addressJson !== undefined && patch.lat === undefined && patch.lng === undefined) {
    const query = toGeocodeQuery(patch.addressJson);
    if (hasGeocodableAddress(query)) {
      const point = await getGeocoder().geocode(query);
      if (point) patch = { ...patch, lat: point.lat, lng: point.lng };
    }
  }
  return patch;
}

/**
 * The full-edit body shared by draft edits and approved change requests:
 * window validation, venue-vs-standalone scope resolution, tier + question
 * replacement, and the audit row. `tierMode` picks the tier strategy —
 * 'replace' (draft: regenerate rows via {@link replaceTiers}) or 'live'
 * (published: id-preserving {@link applyLiveTiers}, so sold tickets stay
 * attached to their tiers). Runs inside the caller's transaction; the caller
 * has already routed on event status.
 */
async function applyEventPatchTx(
  tx: Tx,
  ctx: AuditCtx,
  existing: Event,
  patch: UpdateEventPatch,
  opts: { auditAction: string; tierMode: 'replace' | 'live' },
): Promise<Event> {
  const eventId = existing.id;
  const startsAt = patch.startsAt ?? existing.startsAt;
  const endsAt = patch.endsAt ?? existing.endsAt;
  if (startsAt >= endsAt) {
    throw new BadRequest('startsAt must be before endsAt', 'invalid_event_window');
  }

  const set: Partial<NewEvent> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.startsAt !== undefined) set.startsAt = patch.startsAt;
  if (patch.endsAt !== undefined) set.endsAt = patch.endsAt;
  if (patch.qrTicketConfig !== undefined) set.qrTicketConfig = patch.qrTicketConfig;
  if (patch.maxPerUser !== undefined) set.maxPerUser = patch.maxPerUser;

  // Resolve the post-update scope: a venue id in the patch wins, otherwise the
  // event keeps whatever scope it already has.
  const targetVenueId =
    patch.venueId !== undefined ? patch.venueId : existing.venueId;

  if (patch.venueId !== undefined && patch.venueId) {
    // Venue-scoped: location is read from the venue — clear standalone fields.
    set.venueId = patch.venueId;
    set.addressJson = null;
    set.lat = null;
    set.lng = null;
    set.tzName = null;
  } else if (!targetVenueId) {
    // Standalone (becoming or staying). Address/tz come from the patch when
    // provided, else from what the event already carries.
    const addressJson = patch.addressJson ?? existing.addressJson;
    const tzName = patch.tzName ?? existing.tzName;
    if (!addressJson || Object.keys(addressJson).length === 0) {
      throw new BadRequest(
        'Standalone events require a non-empty address',
        'event_address_required',
      );
    }
    if (!tzName) {
      throw new BadRequest('Standalone events require a timezone', 'event_tz_required');
    }
    if (patch.venueId !== undefined) set.venueId = null;
    if (patch.addressJson !== undefined) set.addressJson = patch.addressJson;
    if (patch.tzName !== undefined) set.tzName = patch.tzName;
    if (patch.lat !== undefined) set.lat = patch.lat;
    if (patch.lng !== undefined) set.lng = patch.lng;
  }

  if (Object.keys(set).length > 0) {
    await tx.update(events).set(set).where(eq(events.id, eventId));
  }

  if (patch.tiers !== undefined) {
    if (opts.tierMode === 'live') {
      await applyLiveTiers(tx, eventId, ctx.tenantId, patch.tiers);
    } else {
      await replaceTiers(tx, eventId, ctx.tenantId, patch.tiers);
    }
  }

  if (patch.questions !== undefined) {
    await replaceQuestions(tx, eventId, ctx.tenantId, patch.questions);
  }

  const [updated] = await tx
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  await writeAudit(
    tx,
    ctx,
    opts.auditAction,
    'event',
    eventId,
    existing as unknown as Record<string, unknown>,
    set,
  );

  return updated!;
}

/**
 * Update an Event. Drafts are fully editable. Published events accept ONLY the
 * live settings (per-customer ticket limit, increase-only tier capacity,
 * description, QR config, registration questions) via {@link applyLiveSettings};
 * pending_review/cancelled/rejected stay immutable. Published events change
 * their approval-gated fields (name/window/location/tiers) through
 * {@link applyApprovedChangePatch} instead, driven by the change-request flow.
 */
export async function updateEvent(
  ctx: AuditCtx,
  eventId: string,
  patch: UpdateEventPatch,
): Promise<Event> {
  patch = await prepareEventPatch(patch);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))
      .limit(1);

    if (!existing) throw new NotFound('Event not found', 'event_not_found');
    if (existing.status === 'published') {
      return applyLiveSettings(tx, ctx, existing, patch);
    }
    if (existing.status !== 'draft') {
      throw new Conflict('Only draft events can be edited', 'event_not_draft');
    }
    if (patch.tierCapacities !== undefined) {
      // Draft tiers are replace-all via `tiers`; the by-id path is live-only.
      throw new BadRequest('Edit a draft event’s tiers via `tiers`', 'bad_request');
    }

    return applyEventPatchTx(tx, ctx, existing, patch, {
      auditAction: 'event.updated',
      tierMode: 'replace',
    });
  });
}

/**
 * Apply an APPROVED change request's patch to a still-published event, inside
 * the approver's transaction. Reuses the draft-edit validation wholesale
 * (window, scope/address, geocoded pin already prepared by the caller via
 * {@link prepareEventPatch}) with the id-preserving live tier strategy.
 */
export async function applyApprovedChangePatch(
  tx: Tx,
  ctx: AuditCtx,
  existing: Event,
  patch: UpdateEventPatch,
): Promise<Event> {
  return applyEventPatchTx(tx, ctx, existing, patch, {
    auditAction: 'event.updated',
    tierMode: 'live',
  });
}

/**
 * Submit a draft event for Circls review: draft → pending_review. (Listing
 * approval, subproject B — the partner's "publish" action hands off to ops, who
 * approve pending_review → published via the admin listings workflow.)
 */
export async function publishEvent(ctx: AuditCtx, eventId: string): Promise<Event> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))
      .limit(1);
    if (!existing) throw new NotFound('Event not found', 'event_not_found');
    if (existing.status !== 'draft') {
      throw new Conflict('Only draft events can be submitted for review', 'event_not_draft');
    }

    const [updated] = await tx
      .update(events)
      .set({ status: 'pending_review' })
      .where(eq(events.id, eventId))
      .returning();

    await writeAudit(tx, ctx, 'event.submitted_for_review', 'event', eventId, { status: 'draft' }, { status: 'pending_review' });

    return updated!;
  });
}

/**
 * Cancel an event (any non-terminal state → cancelled). Idempotent-ish: already
 * cancelled/rejected events are rejected with a 409.
 */
export async function cancelEvent(ctx: AuditCtx, eventId: string): Promise<Event> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))
      .limit(1);
    if (!existing) throw new NotFound('Event not found', 'event_not_found');
    if (existing.status === 'cancelled' || existing.status === 'rejected') {
      throw new Conflict(`Event is already ${existing.status}`, 'event_not_cancellable', {
        status: existing.status,
      });
    }

    const [updated] = await tx
      .update(events)
      .set({ status: 'cancelled' })
      .where(eq(events.id, eventId))
      .returning();

    await revokeQrTicketsForEvent(eventId, tx);

    await writeAudit(tx, ctx, 'event.cancelled', 'event', eventId, { status: existing.status }, { status: 'cancelled' });

    return updated!;
  });
}
