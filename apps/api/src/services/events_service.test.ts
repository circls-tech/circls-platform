import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { tenants, users, venues } from '../db/schema/index.js';
import { createEvent, listEventsForTenant } from './events_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('events_service — scoping', () => {
  let tenantId: string;
  let venueId: string;
  let actorUserId: string;
  const ctx = () => ({ tenantId, actorUserId });

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `evtsvc-${Date.now()}`, email: `evt-${Date.now()}@test.x` })
      .returning();
    actorUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'EvtSvc', slug: `evtsvc-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'EvtSvc Venue', status: 'active' })
      .returning();
    venueId = v!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${actorUserId}`);
    await closeDb();
  });

  it('creates a venue-scoped event with null location columns', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: 'Venue Event',
      startsAt: new Date('2030-01-01T10:00:00Z'),
      endsAt: new Date('2030-01-01T12:00:00Z'),
      pricePaise: 0,
    });
    expect(ev.venueId).toBe(venueId);
    expect(ev.addressJson).toBeNull();
    expect(ev.tzName).toBeNull();
  });

  it('creates an org-scoped event with a standalone address + tz', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      addressJson: { line1: '1 Park Rd', city: 'Pune' },
      lat: 18.52,
      lng: 73.85,
      tzName: 'Asia/Kolkata',
      name: 'Org Event',
      startsAt: new Date('2030-02-01T10:00:00Z'),
      endsAt: new Date('2030-02-01T12:00:00Z'),
      pricePaise: 0,
    });
    expect(ev.venueId).toBeNull();
    expect(ev.tzName).toBe('Asia/Kolkata');
    expect((ev.addressJson as Record<string, unknown>).city).toBe('Pune');
  });

  it('rejects a standalone event missing an address', async () => {
    await expect(
      createEvent(ctx(), {
        tenantId,
        tzName: 'Asia/Kolkata',
        name: 'No Address',
        startsAt: new Date('2030-03-01T10:00:00Z'),
        endsAt: new Date('2030-03-01T12:00:00Z'),
        pricePaise: 0,
      }),
    ).rejects.toThrow();
  });

  it('lists all events for the tenant (venue + standalone)', async () => {
    const rows = await listEventsForTenant(tenantId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.venueId === venueId)).toBe(true);
    expect(rows.some((r) => r.venueId === null)).toBe(true);
  });
});
