/**
 * Consumer visibility — the security-critical rule: a listing is public iff it
 * is approved AND its tenant is active. Integration (RUN_INTEGRATION + DB).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { arenas, tenants, venues } from '../db/schema/index.js';
import { getPublicVenue, listPublicArenas, listPublicVenues } from './consumer_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('consumer visibility', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  const tag = `consumervis-${Date.now()}`;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: 'ConsumerVis', slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: `Vis Venue ${tag}`, status: 'pending_review' })
      .returning();
    venueId = v!.id;
    const [a] = await db
      .insert(arenas)
      .values({ venueId, name: 'Court', status: 'pending_review' })
      .returning();
    arenaId = a!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from arenas where venue_id = ${venueId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('hides a pending_review venue', async () => {
    expect(await getPublicVenue(venueId)).toBeNull();
    const list = await listPublicVenues({ search: tag });
    expect(list.find((v) => v.id === venueId)).toBeUndefined();
  });

  it('shows the venue once approved (active)', async () => {
    await db.update(venues).set({ status: 'active' }).where(eq(venues.id, venueId));
    expect((await getPublicVenue(venueId))?.id).toBe(venueId);
    const list = await listPublicVenues({ search: tag });
    expect(list.find((v) => v.id === venueId)).toBeTruthy();
  });

  it('only lists approved arenas under a visible venue', async () => {
    // venue is active; arena still pending_review → excluded.
    expect(await listPublicArenas(venueId)).toHaveLength(0);
    await db.update(arenas).set({ status: 'active' }).where(eq(arenas.id, arenaId));
    const list = await listPublicArenas(venueId);
    expect(list.find((a) => a.id === arenaId)).toBeTruthy();
  });

  it('hides everything when the tenant is suspended', async () => {
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, tenantId));
    expect(await getPublicVenue(venueId)).toBeNull();
    await expect(listPublicArenas(venueId)).rejects.toMatchObject({ code: 'venue_not_found' });
  });
});
