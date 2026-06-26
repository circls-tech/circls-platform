/**
 * Personal sandbox seed — YOUR demo data (venues, courts, slots, …).
 *
 * Why this exists: editing the shared `seed_sandbox.ts` to add demo data is what
 * causes merge conflicts. This file is the per-developer escape hatch.
 *
 * Usage (one time):
 *   cp apps/api/src/scripts/seed_local.example.ts apps/api/src/scripts/seed_local.ts
 * then edit `seed_local.ts` however you like. It is git-ignored, so your changes
 * are never committed and can't conflict. `pnpm --filter @circls/api seed:sandbox`
 * (and `./sandbox seed`) run it automatically at the end if it exists.
 *
 * Keep it idempotent — the seed can be re-run, so guard against duplicates.
 *
 * The example below recreates a "Test Venue" with two badminton courts and a
 * day-and-a-bit of bookable 30-minute slots. Delete or change anything.
 */
import { and, eq, sql } from 'drizzle-orm';
import { arenas } from '../db/schema/arenas.js';
import { venues } from '../db/schema/venues.js';
import { logger } from '../lib/logger.js';
import type { LocalSeedContext } from './seed_sandbox.js';

export async function seedLocal({ db, demoTenantId }: LocalSeedContext): Promise<void> {
  const venueName = 'Test Venue';

  // Idempotent: bail if this venue already exists for the demo tenant.
  const [existing] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.tenantId, demoTenantId), eq(venues.name, venueName)))
    .limit(1);
  if (existing) {
    logger.info({ venueId: existing.id }, 'seed_local: venue already present, skipping');
    return;
  }

  const [venue] = await db
    .insert(venues)
    .values({ tenantId: demoTenantId, name: venueName, status: 'active', tzName: 'Asia/Kolkata', tags: ['badminton'] })
    .returning({ id: venues.id });
  const venueId = venue!.id;

  const courtRows = await db
    .insert(arenas)
    .values(
      ['Court A', 'Court B'].map((name) => ({
        venueId,
        name,
        sport: 'Badminton',
        capacity: 4,
        slotDurationMin: 30,
      })),
    )
    .returning({ id: arenas.id });

  // Open 30-minute slots (₹500) for today + tomorrow on each court, so there's
  // always something bookable regardless of the current time.
  for (const court of courtRows) {
    await db.execute(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status)
      select ${demoTenantId}::uuid, ${court.id}::uuid,
             tstzrange(g.start, g.start + interval '30 min', '[)'), 50000, 'open'
      from generate_series(
        date_trunc('day', now()),
        date_trunc('day', now()) + interval '1 day' + interval '23 hour 30 min',
        interval '30 min'
      ) as g(start)
    `);
  }

  logger.info({ venueId, courts: courtRows.length }, 'seed_local: created Test Venue with two courts + slots');
}
