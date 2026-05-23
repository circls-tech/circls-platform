import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type PricingRule, pricingRules } from '../db/schema/index.js';
import { getArenaById } from './arena_service.js';
import { getVenueById } from './venue_service.js';

export type Channel = 'circls' | 'aggregator' | 'venue_site' | 'walkin';

export interface CreatePricingRuleInput {
  priority?: number;
  dayOfWeek?: number | null;
  startTimeMin?: number | null;
  startTimeMax?: number | null;
  channel?: Channel | null;
  memberOnly?: boolean;
  pricePaise: number;
}

export async function createPricingRule(
  arenaId: string,
  input: CreatePricingRuleInput,
): Promise<PricingRule> {
  const [r] = await db
    .insert(pricingRules)
    .values({
      arenaId,
      priority: input.priority ?? 0,
      dayOfWeek: input.dayOfWeek ?? null,
      startTimeMin: input.startTimeMin ?? null,
      startTimeMax: input.startTimeMax ?? null,
      channel: input.channel ?? null,
      memberOnly: input.memberOnly ?? false,
      pricePaise: input.pricePaise,
    })
    .returning();
  if (!r) throw new Error('pricing rule insert returned no row');
  return r;
}

/** Rules for an arena, highest priority first. */
export async function listPricingRules(arenaId: string): Promise<PricingRule[]> {
  return db
    .select()
    .from(pricingRules)
    .where(eq(pricingRules.arenaId, arenaId))
    .orderBy(desc(pricingRules.priority));
}

export async function deletePricingRule(arenaId: string, ruleId: string): Promise<void> {
  await db
    .delete(pricingRules)
    .where(and(eq(pricingRules.id, ruleId), eq(pricingRules.arenaId, arenaId)));
}

export interface ResolvePriceArgs {
  arenaId: string;
  startAt: string; // ISO
  channel: Channel;
  memberOnly?: boolean;
  tzName?: string;
}

/**
 * Resolve the price for a slot by walking rules in priority order and returning
 * the first whose filters all match. Returns null if no rule matches (caller may
 * fall back to a manually-entered amount). Day/time are evaluated in venue-local
 * time so a "Saturday evening" rule means local Saturday evening.
 */
export async function resolvePricePaise(args: ResolvePriceArgs): Promise<number | null> {
  let tz = args.tzName;
  if (!tz) {
    const arena = await getArenaById(args.arenaId);
    const venue = arena ? await getVenueById(arena.venueId) : undefined;
    tz = venue?.tzName ?? 'Asia/Kolkata';
  }
  const { dow, minutes } = localDayAndMinutes(args.startAt, tz);
  const isMember = args.memberOnly ?? false;

  for (const r of await listPricingRules(args.arenaId)) {
    if (r.dayOfWeek !== null && r.dayOfWeek !== dow) continue;
    if (r.startTimeMin !== null && minutes < r.startTimeMin) continue;
    if (r.startTimeMax !== null && minutes >= r.startTimeMax) continue;
    if (r.channel !== null && r.channel !== args.channel) continue;
    if (r.memberOnly && !isMember) continue;
    return r.pricePaise;
  }
  return null;
}

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localDayAndMinutes(iso: string, tz: string): { dow: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const rawHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const hour = rawHour === 24 ? 0 : rawHour; // some ICU builds emit '24' at midnight
  return { dow: WEEKDAY[wd] ?? 0, minutes: hour * 60 + minute };
}
