import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./notification_hooks.js', () => ({
  onListingSubmitted: vi.fn(),
  onListingReviewed: vi.fn(),
  onEventCancelled: vi.fn(),
}));

import { closeDb, db } from '../db/client.js';
import { arenas, auditLog, bookings, eventBookingTickets, eventChangeRequests, events, memberships, tenants, users, venues } from '../db/schema/index.js';
import { createArena, submitArenaForReview, updateArenaDetails } from './arena_service.js';
import { createChangeRequest } from './event_change_requests_service.js';
import { listTiers } from './event_tiers_service.js';
import { createEvent, createEventSeries, publishEvent, publishEventSeries } from './events_service.js';
import { createMembership, setMembershipActive, submitMembershipForReview, updateMembership } from './memberships_service.js';
import { onListingReviewed, onListingSubmitted } from './notification_hooks.js';
import { createVenue, submitVenueForReview, updateVenue } from './venue_service.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('tenant listing auto-approval', () => {
  let tenantId: string;
  let otherTenantId: string;
  let actorUserId: string;
  let venueId: string;
  const ctx = () => ({ tenantId, actorUserId });
  const eventInput = () => ({
    tenantId,
    venueId,
    name: 'Auto-approval event',
    startsAt: new Date('2031-01-01T10:00:00Z'),
    endsAt: new Date('2031-01-01T12:00:00Z'),
    tiers: [{ name: 'Entry', pricePaise: 10000, capacity: 50 }],
  });

  beforeAll(async () => {
    const [actor] = await db.insert(users).values({ firebaseUid: `auto-approval-${Date.now()}` }).returning();
    actorUserId = actor!.id;
    const [tenant, other] = await db.insert(tenants).values([
      { name: 'Auto-approval', slug: `auto-approval-${Date.now()}`, autoApproveListings: true },
      { name: 'Manual review', slug: `manual-review-${Date.now()}` },
    ]).returning();
    tenantId = tenant!.id;
    otherTenantId = other!.id;
    venueId = (await createVenue(tenantId, { name: 'Live venue' })).id;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.update(tenants).set({ autoApproveListings: true }).where(eq(tenants.id, tenantId));
  });

  afterAll(async () => {
    const tenantIds = [tenantId, otherTenantId];
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
    await db.delete(bookings).where(inArray(bookings.tenantId, tenantIds));
    await db.delete(events).where(inArray(events.tenantId, tenantIds));
    await db.delete(memberships).where(inArray(memberships.tenantId, tenantIds));
    await db.delete(arenas).where(inArray(arenas.venueId, db.select({ id: venues.id }).from(venues).where(inArray(venues.tenantId, tenantIds))));
    await db.delete(venues).where(inArray(venues.tenantId, tenantIds));
    await db.delete(tenants).where(inArray(tenants.id, tenantIds));
    await db.delete(users).where(eq(users.id, actorUserId));
    await closeDb();
  });

  it('defaults to manual review and keeps other tenants unchanged', async () => {
    const [other] = await db.select().from(tenants).where(eq(tenants.id, otherTenantId));
    expect(other!.autoApproveListings).toBe(false);
    const venue = await createVenue(otherTenantId, { name: 'Needs review' });
    expect(venue.status).toBe('pending_review');
    expect(onListingSubmitted).toHaveBeenCalledWith('venue', venue.id);
    const event = await createEvent({ tenantId: otherTenantId, actorUserId }, {
      ...eventInput(), tenantId: otherTenantId, venueId: venue.id,
    });
    expect((await publishEvent({ tenantId: otherTenantId, actorUserId }, event.id)).status).toBe('pending_review');
    const plan = await createMembership({ tenantId: otherTenantId, actorUserId, name: 'Manual plan', pricePaise: 0, durationDays: 30 });
    expect(plan.status).toBe('pending_review');
  });

  it('makes new venues, arenas and memberships live without review notifications', async () => {
    const venue = await createVenue(tenantId, { name: 'Auto venue' });
    expect(venue.status).toBe('active');
    const arena = await createArena(venue.id, { name: 'Auto arena' });
    expect(arena.status).toBe('active');
    expect((await updateArenaDetails(ctx(), arena.id, { name: 'Edited arena' })).status).toBe('active');
    expect((await updateVenue(tenantId, venue.id, { name: 'Edited venue' })).status).toBe('active');
    const plan = await createMembership({ ...ctx(), name: 'Auto plan', pricePaise: 0, durationDays: 30 });
    expect(plan.status).toBe('active');
    await expect(updateMembership(ctx(), plan.id, { name: 'Live edit' })).rejects.toMatchObject({ code: 'membership_not_editable' });
    await setMembershipActive(ctx(), plan.id, false);
    await updateMembership(ctx(), plan.id, { name: 'Edited plan' });
    expect((await setMembershipActive(ctx(), plan.id, true)).status).toBe('active');
    expect(onListingSubmitted).not.toHaveBeenCalled();
    expect(onListingReviewed).not.toHaveBeenCalled();
  });

  it('preserves drafts and refuses incomplete event and membership submissions', async () => {
    const venue = await createVenue(tenantId, { name: 'Venue draft', draft: true });
    expect(venue.status).toBe('draft');
    expect((await submitVenueForReview(ctx(), venue.id)).status).toBe('active');
    const event = await createEvent(ctx(), { tenantId, name: 'Incomplete', tiers: [] });
    expect(event.status).toBe('draft');
    await expect(publishEvent(ctx(), event.id)).rejects.toMatchObject({ code: 'event_incomplete' });
    const plan = await createMembership({ ...ctx(), name: 'Plan draft', draft: true });
    expect(plan.status).toBe('draft');
    await expect(submitMembershipForReview(ctx(), plan.id)).rejects.toMatchObject({ code: 'membership_incomplete' });
    await updateMembership(ctx(), plan.id, { tiers: [{ name: 'Monthly', pricePaise: 0, durationDays: 30 }] });
    expect((await submitMembershipForReview(ctx(), plan.id)).status).toBe('active');
    expect(onListingSubmitted).not.toHaveBeenCalled();
  });

  it('publishes complete events and recurring series, with an audit trail', async () => {
    const event = await createEvent(ctx(), eventInput());
    expect(event.status).toBe('draft');
    expect((await publishEvent(ctx(), event.id)).status).toBe('published');
    const series = await createEventSeries(ctx(), [eventInput(), {
      ...eventInput(), startsAt: new Date('2031-01-08T10:00:00Z'), endsAt: new Date('2031-01-08T12:00:00Z'),
    }]);
    expect((await publishEventSeries(ctx(), series[0]!.seriesId!)).every((date) => date.status === 'published')).toBe(true);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityId, event.id), eq(auditLog.action, 'event.auto_approved')));
    expect(audits).toHaveLength(1);
    expect(onListingSubmitted).not.toHaveBeenCalled();
    expect(onListingReviewed).not.toHaveBeenCalled();
  });

  it('keeps all dates as drafts when one series occurrence is incomplete', async () => {
    const series = await createEventSeries(ctx(), [eventInput(), { ...eventInput(), tiers: [] }]);
    await expect(publishEventSeries(ctx(), series[0]!.seriesId!)).rejects.toMatchObject({ code: 'event_incomplete' });
    const rows = await db.select().from(events).where(eq(events.seriesId, series[0]!.seriesId!));
    expect(rows.every((date) => date.status === 'draft')).toBe(true);
    expect(onListingSubmitted).not.toHaveBeenCalled();
  });

  it('auto-approves resubmitted rejected listings without skipping completion checks', async () => {
    const venue = await createVenue(tenantId, { name: 'Rejected venue', draft: true });
    await db.update(venues).set({ status: 'rejected' }).where(eq(venues.id, venue.id));
    expect((await submitVenueForReview(ctx(), venue.id)).status).toBe('active');
    const arena = await createArena(venue.id, { name: 'Rejected arena' });
    await db.execute(sql`update arenas set status = 'rejected' where id = ${arena.id}`);
    expect((await submitArenaForReview(ctx(), arena.id)).status).toBe('active');
    const event = await createEvent(ctx(), eventInput());
    await db.update(events).set({ status: 'rejected' }).where(eq(events.id, event.id));
    expect((await publishEvent(ctx(), event.id)).status).toBe('published');
    expect(onListingSubmitted).not.toHaveBeenCalled();
  });

  it('applies later event changes immediately and preserves ticket tier identities', async () => {
    const event = await createEvent(ctx(), eventInput());
    await publishEvent(ctx(), event.id);
    const [tier] = await listTiers(db, event.id);
    const request = await createChangeRequest(ctx(), event.id, {
      name: 'Changed live', tiers: [{ id: tier!.id, name: 'Updated entry', pricePaise: 12000, capacity: 60 }],
    });
    expect(request.status).toBe('approved');
    expect(request.reviewedAt).not.toBeNull();
    expect(request.reviewedBy).toBeNull();
    const [updated] = await db.select().from(events).where(eq(events.id, event.id));
    expect(updated).toMatchObject({ name: 'Changed live', status: 'published' });
    expect((await listTiers(db, event.id))[0]).toMatchObject({ id: tier!.id, pricePaise: 12000 });
    expect(onListingSubmitted).not.toHaveBeenCalled();
    expect(onListingReviewed).not.toHaveBeenCalled();
  });

  it('rejects invalid dates and unsafe tier changes without applying anything', async () => {
    const event = await createEvent(ctx(), eventInput());
    await publishEvent(ctx(), event.id);
    const [tier] = await listTiers(db, event.id);
    const [booking] = await db.insert(bookings).values({
      tenantId, venueId, itemType: 'event', channel: 'circls', paymentMethod: 'free',
      itemData: { eventId: event.id }, totalPaise: 0, status: 'confirmed', customerName: 'Buyer',
    }).returning();
    await db.insert(eventBookingTickets).values({ bookingId: booking!.id, tierId: tier!.id, quantity: 2, unitPricePaise: 0 });
    await expect(createChangeRequest(ctx(), event.id, { endsAt: '2030-01-01T12:00:00Z' }))
      .rejects.toMatchObject({ code: 'invalid_event_window' });
    await expect(createChangeRequest(ctx(), event.id, {
      tiers: [{ id: tier!.id, name: tier!.name, pricePaise: 10000, capacity: 1 }],
    })).rejects.toMatchObject({ code: 'tier_capacity_below_sold' });
    await expect(createChangeRequest(ctx(), event.id, { tiers: [{ name: 'Replacement', pricePaise: 0 }] }))
      .rejects.toMatchObject({ code: 'tier_has_bookings' });
    expect(await db.select().from(eventChangeRequests).where(eq(eventChangeRequests.eventId, event.id))).toHaveLength(0);
  });

  it('returns future submissions and changes to manual review when disabled', async () => {
    const event = await createEvent(ctx(), eventInput());
    await publishEvent(ctx(), event.id);
    await db.update(tenants).set({ autoApproveListings: false }).where(eq(tenants.id, tenantId));
    const request = await createChangeRequest(ctx(), event.id, { name: 'Needs approval' });
    expect(request.status).toBe('pending');
    const [unchanged] = await db.select().from(events).where(eq(events.id, event.id));
    expect(unchanged!.name).toBe(event.name);
    const draft = await createEvent(ctx(), eventInput());
    expect((await publishEvent(ctx(), draft.id)).status).toBe('pending_review');
    expect(onListingSubmitted).toHaveBeenCalledWith('event', draft.id);
  });

  it('refuses a later change to a venue owned by another tenant', async () => {
    const otherVenue = await createVenue(otherTenantId, { name: 'Other tenant venue' });
    const event = await createEvent(ctx(), eventInput());
    await publishEvent(ctx(), event.id);
    await expect(createChangeRequest(ctx(), event.id, { venueId: otherVenue.id }))
      .rejects.toMatchObject({ code: 'venue_not_found' });
    const [unchanged] = await db.select().from(events).where(eq(events.id, event.id));
    expect(unchanged!.venueId).toBe(venueId);
  });
});
