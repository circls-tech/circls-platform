import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Arena, arenas } from '../db/schema/index.js';
import { inferSport } from '../lib/sport_inference.js';

export interface CreateArenaInput {
  name: string;
  sport?: string | null;
  capacity?: number | null;
  slotDurationMin?: number;
  tags?: string[];
}

export async function createArena(venueId: string, input: CreateArenaInput): Promise<Arena> {
  const tags = input.tags ?? [];
  // Explicit sport wins; fall back to tag-based inference; then null.
  const sport = input.sport ?? inferSport(tags) ?? null;

  const [a] = await db
    .insert(arenas)
    .values({
      venueId,
      name: input.name,
      sport,
      capacity: input.capacity ?? null,
      slotDurationMin: input.slotDurationMin ?? 60,
      tags,
      // New listings await Circls review before going live (subproject B).
      status: 'pending_review',
    })
    .returning();
  if (!a) throw new Error('arena insert returned no row');
  return a;
}

export async function listArenas(venueId: string): Promise<Arena[]> {
  return db.select().from(arenas).where(eq(arenas.venueId, venueId));
}

/** Unscoped lookup — callers resolve the arena's venue → tenant for authz. */
export async function getArenaById(arenaId: string): Promise<Arena | undefined> {
  return db.query.arenas.findFirst({ where: eq(arenas.id, arenaId) });
}
