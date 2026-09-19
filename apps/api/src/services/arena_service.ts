import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Arena, arenas } from '../db/schema/index.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { Conflict, NotFound } from '../lib/errors.js';
import type { QrTicketConfig } from '../db/schema/qr_ticket_config.js';
import { inferSport } from '../lib/sport_inference.js';

export interface CreateArenaInput {
  name: string;
  sport?: string | null;
  capacity?: number | null;
  slotDurationMin?: number;
  tags?: string[];
  /** QR entry-ticket rules for bookings on this arena (null/omitted = disabled). */
  qrTicketConfig?: QrTicketConfig | null;
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
      qrTicketConfig: input.qrTicketConfig ?? null,
      // New listings await Circls review before going live (subproject B).
      status: 'pending_review',
    })
    .returning();
  if (!a) throw new Error('arena insert returned no row');
  return a;
}

/** Set/clear the arena's QR-ticket rules (affects future bookings only —
 *  already-issued tickets keep their frozen rules). */
export async function updateArenaQrTicketConfig(
  arenaId: string,
  config: QrTicketConfig | null,
): Promise<Arena> {
  const [a] = await db
    .update(arenas)
    .set({ qrTicketConfig: config })
    .where(eq(arenas.id, arenaId))
    .returning();
  if (!a) throw new Error('arena update returned no row');
  return a;
}

export async function listArenas(venueId: string): Promise<Arena[]> {
  return db.select().from(arenas).where(eq(arenas.venueId, venueId));
}

/** Unscoped lookup — callers resolve the arena's venue → tenant for authz. */
export async function getArenaById(arenaId: string): Promise<Arena | undefined> {
  return db.query.arenas.findFirst({ where: eq(arenas.id, arenaId) });
}

/**
 * Close an arena: stop it being booked online while the rest of its venue
 * stays open. Mirrors closeVenue — closed is `suspended`, the prior status is
 * kept for reopening, and nothing is deleted or cancelled. Closing an already
 * closed arena is a no-op so a retry can't overwrite the saved status.
 *
 * Callers must have authorised the arena against `ctx.tenantId` already;
 * arenas carry no tenant of their own.
 */
export async function closeArena(ctx: AuditCtx, arenaId: string): Promise<Arena> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(arenas)
      .where(eq(arenas.id, arenaId))
      .limit(1)
      .for('update');
    if (!existing) throw new NotFound('Arena not found', 'arena_not_found');
    if (existing.status === 'suspended') return existing;

    const [updated] = await tx
      .update(arenas)
      .set({ status: 'suspended', statusBeforeClose: existing.status })
      .where(eq(arenas.id, arenaId))
      .returning();
    await writeAudit(tx, ctx, 'arena.closed', 'arena', arenaId, { status: existing.status }, { status: 'suspended' });
    return updated!;
  });
}

/**
 * Reopen a closed arena, back to exactly where it was. Like reopenVenue, an
 * arena with nothing recorded goes back to review rather than live.
 */
export async function reopenArena(ctx: AuditCtx, arenaId: string): Promise<Arena> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(arenas)
      .where(eq(arenas.id, arenaId))
      .limit(1)
      .for('update');
    if (!existing) throw new NotFound('Arena not found', 'arena_not_found');
    if (existing.status !== 'suspended') {
      throw new Conflict('Only a closed arena can be reopened', 'arena_not_closed', {
        status: existing.status,
      });
    }

    const restored = existing.statusBeforeClose ?? 'pending_review';
    const [updated] = await tx
      .update(arenas)
      .set({ status: restored, statusBeforeClose: null })
      .where(eq(arenas.id, arenaId))
      .returning();
    await writeAudit(tx, ctx, 'arena.reopened', 'arena', arenaId, { status: 'suspended' }, { status: restored });
    return updated!;
  });
}
