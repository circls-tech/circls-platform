import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { arenas, tenants, venues } from '../db/schema/index.js';
import { createPricingRule, resolvePricePaise } from './pricing_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('pricing engine', () => {
  let arenaId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: 'Price', slug: `price-${Date.now()}` }).returning();
    const [v] = await db.insert(venues).values({ tenantId: t!.id, name: 'V', tzName: 'Asia/Kolkata' }).returning();
    const [a] = await db.insert(arenas).values({ venueId: v!.id, name: 'A' }).returning();
    arenaId = a!.id;
    // Base/default rule (matches anything), and a higher-priority Sat-evening surcharge.
    await createPricingRule(arenaId, { pricePaise: 50000, priority: 0 });
    await createPricingRule(arenaId, {
      pricePaise: 80000,
      priority: 10,
      dayOfWeek: 6,
      startTimeMin: 18 * 60,
      startTimeMax: 23 * 60,
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  it('applies the Saturday-evening surcharge (venue-local time)', async () => {
    // 2026-07-04 is a Saturday; 18:00 IST == 12:30 UTC.
    const price = await resolvePricePaise({ arenaId, startAt: '2026-07-04T12:30:00Z', channel: 'walkin' });
    expect(price).toBe(80000);
  });

  it('falls back to the default at other times', async () => {
    // 2026-07-01 is a Wednesday; 12:00 IST == 06:30 UTC.
    const price = await resolvePricePaise({ arenaId, startAt: '2026-07-01T06:30:00Z', channel: 'walkin' });
    expect(price).toBe(50000);
  });

  it('returns null when no rule matches', async () => {
    const [t] = await db.insert(tenants).values({ name: 'NoRule', slug: `norule-${Date.now()}` }).returning();
    const [v] = await db.insert(venues).values({ tenantId: t!.id, name: 'V' }).returning();
    const [a] = await db.insert(arenas).values({ venueId: v!.id, name: 'A' }).returning();
    const price = await resolvePricePaise({ arenaId: a!.id, startAt: '2026-07-01T06:30:00Z', channel: 'walkin' });
    expect(price).toBeNull();
  });
});
