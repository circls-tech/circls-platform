import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { events, tenants } from '../db/schema/index.js';
import { getPublicEventById, listPublicUpcomingEvents } from './consumer_service.js';

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
        status: 'published',
      })
      .returning();
    eventId = e!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
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
});
