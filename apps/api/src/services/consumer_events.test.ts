import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { events, tenants, venues } from '../db/schema/index.js';
import {
  getPublicEventById,
  listPublicEvents,
  listPublicUpcomingEvents,
} from './consumer_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('consumer org-scoped events', () => {
  let tenantId: string;
  let eventId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'ConsumerOrg', slug: `consorg-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [e] = await db
      .insert(events)
      .values({
        tenantId,
        venueId: null,
        addressJson: { line1: '9 Hill Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Public Org Event',
        startsAt: new Date('2030-09-01T10:00:00Z'),
        endsAt: new Date('2030-09-01T12:00:00Z'),
        pricePaise: 0,
        postBookingRedirect: {
          url: 'https://chat.whatsapp.com/private-invite',
          description: 'Join the group',
          forced: false,
        },
        status: 'published',
      })
      .returning();
    eventId = e!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('surfaces a venue-less published event in the cross-venue list', async () => {
    const rows = await listPublicUpcomingEvents({ limit: 100 });
    const row = rows.find((r) => r.id === eventId);
    expect(row).toBeTruthy();
    expect(row!.isStandalone).toBe(true);
    expect(row!.venueName).toBeNull();
    expect(row!.locationName).toBe('ConsumerOrg');
    expect(row!.locTzName).toBe('Asia/Kolkata');
  });

  it('fetches a single standalone event by id with resolved location', async () => {
    const row = await getPublicEventById(eventId);
    expect(row).toBeTruthy();
    expect(row!.isStandalone).toBe(true);
    expect((row!.locAddressJson as Record<string, unknown>).city).toBe('Pune');
  });

  it('keeps the post-booking redirect out of the public payloads', async () => {
    // The organiser's group invite belongs to people who booked — a browsing
    // visitor must not be able to lift it off the listing JSON.
    const row = await getPublicEventById(eventId);
    expect(row).not.toHaveProperty('postBookingRedirect');

    const listRow = (await listPublicUpcomingEvents({ limit: 100 })).find(
      (r) => r.id === eventId,
    );
    expect(listRow).not.toHaveProperty('postBookingRedirect');
  });

  it('keeps it out of the per-venue listing too', async () => {
    // Regression: this path returned the raw event row, so the link was served
    // by the unauthenticated GET /v1/consumer/venues/:venueId/events.
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'RedirectLeakV', tzName: 'Asia/Kolkata', status: 'active' })
      .returning();
    const [e] = await db
      .insert(events)
      .values({
        tenantId,
        venueId: v!.id,
        name: 'Venue Listed Event',
        startsAt: new Date('2030-09-02T10:00:00Z'),
        endsAt: new Date('2030-09-02T12:00:00Z'),
        pricePaise: 0,
        postBookingRedirect: { url: 'https://forms.gle/private', description: null, forced: false },
        status: 'published',
      })
      .returning();

    const rows = await listPublicEvents(v!.id);
    const row = rows.find((r) => r.id === e!.id);
    expect(row).toBeTruthy();
    expect(row).not.toHaveProperty('postBookingRedirect');
    expect(JSON.stringify(rows)).not.toContain('forms.gle/private');
  });

  it('keeps the per-event billing rates and the archive flag out of the public payloads', async () => {
    // These are commercial terms between Circls and the partner. The consumer
    // event endpoints are unauthenticated, so a raw `events` row publishes them.
    const [e] = await db
      .insert(events)
      .values({
        tenantId,
        venueId: null,
        addressJson: { line1: '4 Rate Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Billing Leak Event',
        startsAt: new Date('2030-09-03T10:00:00Z'),
        endsAt: new Date('2030-09-03T12:00:00Z'),
        pricePaise: 0,
        partnerCommissionBps: 750,
        consumerCommissionBps: 250,
        advancePayoutBps: 5000,
        archivedAt: new Date('2030-01-01T00:00:00Z'),
        status: 'published',
      })
      .returning();

    const leaked = [
      'partnerCommissionBps',
      'consumerCommissionBps',
      'advancePayoutBps',
      'archivedAt',
    ];

    const detail = await getPublicEventById(e!.id);
    expect(detail).toBeTruthy();
    for (const key of leaked) expect(detail).not.toHaveProperty(key);

    const listRow = (await listPublicUpcomingEvents({ limit: 100 })).find(
      (r) => r.id === e!.id,
    );
    expect(listRow).toBeTruthy();
    for (const key of leaked) expect(listRow).not.toHaveProperty(key);

    // Raw-JSON belt and braces: the bps values must not appear at all.
    expect(JSON.stringify(detail)).not.toContain('750');
    expect(JSON.stringify(detail)).not.toContain('5000');
  });
});
