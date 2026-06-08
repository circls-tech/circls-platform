/**
 * Coupon service — CRUD (added later) plus the validation + resolution used at
 * checkout. `validateCoupon` is pure (no DB) so the constraint logic is unit
 * tested directly; the per-user redemption count + code resolution that need
 * the DB live in `resolveCouponForCheckout` (added with the CRUD).
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { coupons, type Coupon, type NewCoupon } from '../db/schema/coupons.js';
import { events } from '../db/schema/events.js';
import { memberships } from '../db/schema/memberships.js';
import { slots } from '../db/schema/slots.js';
import { arenas } from '../db/schema/arenas.js';
import { couponRedemptions } from '../db/schema/coupon_redemptions.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';

/** The item being purchased, used for scope matching. */
export interface CheckoutItem {
  type: 'slot' | 'event' | 'arena' | 'membership';
  /** The event/membership id, or the arena id for a slot booking. */
  id: string;
  /** The venue the item belongs to, if any (null for org-scoped events). */
  venueId: string | null;
}

export interface CouponValidationContext {
  basePaise: number;
  now: Date;
  item: CheckoutItem;
}

export type CouponErrorCode =
  | 'coupon_not_found'
  | 'coupon_inactive'
  | 'coupon_not_started'
  | 'coupon_expired'
  | 'coupon_scope_mismatch'
  | 'coupon_min_order'
  | 'coupon_max_redeemed'
  | 'coupon_user_limit';

export type CouponValidationResult = { ok: true } | { ok: false; code: CouponErrorCode };

/** Does this coupon's scope cover the item being purchased? */
export function couponMatchesItem(coupon: Coupon, item: CheckoutItem): boolean {
  switch (coupon.scopeType) {
    case 'org':
      return true; // owner-wide (tenant) or platform-wide
    case 'venue':
      return item.venueId != null && item.venueId === coupon.scopeId;
    case 'arena':
      return item.type === 'slot' && item.id === coupon.scopeId;
    case 'event':
      return item.type === 'event' && item.id === coupon.scopeId;
    case 'membership':
      return item.type === 'membership' && item.id === coupon.scopeId;
    default:
      return false;
  }
}

/**
 * Pure constraint check: status, window, scope, min-order, total-cap. Does NOT
 * check the per-user limit (needs a DB count — done in resolveCouponForCheckout).
 */
export function validateCoupon(
  coupon: Coupon,
  ctx: CouponValidationContext,
): CouponValidationResult {
  if (coupon.status !== 'active') return { ok: false, code: 'coupon_inactive' };
  if (coupon.validFrom && ctx.now < coupon.validFrom) return { ok: false, code: 'coupon_not_started' };
  if (coupon.validUntil && ctx.now > coupon.validUntil) return { ok: false, code: 'coupon_expired' };
  if (!couponMatchesItem(coupon, ctx.item)) return { ok: false, code: 'coupon_scope_mismatch' };
  if (coupon.minOrderPaise != null && ctx.basePaise < coupon.minOrderPaise) {
    return { ok: false, code: 'coupon_min_order' };
  }
  if (coupon.maxRedemptions != null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { ok: false, code: 'coupon_max_redeemed' };
  }
  return { ok: true };
}

/** Owner selector: a tenant id for org coupons, or `'platform'`. */
export type CouponOwner = { kind: 'tenant'; tenantId: string } | { kind: 'platform' };

export interface CreateCouponInput {
  code: string;
  description?: string | null;
  scopeType: Coupon['scopeType'];
  scopeId?: string | null;
  discountType: Coupon['discountType'];
  discountValue: number;
  maxDiscountPaise?: number | null;
  minOrderPaise?: number | null;
  visibility?: Coupon['visibility'];
  validFrom?: Date | null;
  validUntil?: Date | null;
  maxRedemptions?: number | null;
  perUserLimit?: number | null;
}

function assertScopeShape(input: { scopeType: Coupon['scopeType']; scopeId?: string | null }): void {
  const needsId = input.scopeType !== 'org';
  if (needsId && !input.scopeId) {
    throw new BadRequest('This scope requires a scopeId', 'coupon_scope_id_required');
  }
  if (!needsId && input.scopeId) {
    throw new BadRequest('org scope must not have a scopeId', 'coupon_scope_id_unexpected');
  }
}

/** True if a thrown DB error is a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function createCoupon(
  ctx: AuditCtx,
  owner: CouponOwner,
  input: CreateCouponInput,
): Promise<Coupon> {
  assertScopeShape(input);
  if (input.discountType === 'percent' && (input.discountValue <= 0 || input.discountValue > 10_000)) {
    throw new BadRequest('Percent discount must be 1–10000 bps', 'coupon_bad_percent');
  }
  if (input.discountType === 'fixed' && input.discountValue <= 0) {
    throw new BadRequest('Fixed discount must be positive', 'coupon_bad_fixed');
  }
  const values: NewCoupon = {
    ownerType: owner.kind === 'tenant' ? 'tenant' : 'platform',
    tenantId: owner.kind === 'tenant' ? owner.tenantId : null,
    code: input.code.trim(),
    description: input.description ?? null,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    discountType: input.discountType,
    discountValue: input.discountValue,
    maxDiscountPaise: input.maxDiscountPaise ?? null,
    minOrderPaise: input.minOrderPaise ?? null,
    visibility: input.visibility ?? 'private',
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    maxRedemptions: input.maxRedemptions ?? null,
    perUserLimit: input.perUserLimit ?? null,
  };
  return db.transaction(async (tx) => {
    let row: Coupon | undefined;
    try {
      [row] = await tx.insert(coupons).values(values).returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Conflict('A coupon with this code already exists', 'coupon_code_taken');
      }
      throw err;
    }
    if (!row) throw new Error('coupon insert returned no row');
    await writeAudit(tx, ctx, 'coupon.created', 'coupon', row.id, null, {
      code: row.code,
      scopeType: row.scopeType,
      discountType: row.discountType,
      discountValue: row.discountValue,
    });
    return row;
  });
}

export async function listCoupons(owner: CouponOwner): Promise<Coupon[]> {
  const where =
    owner.kind === 'tenant'
      ? and(eq(coupons.ownerType, 'tenant'), eq(coupons.tenantId, owner.tenantId))
      : eq(coupons.ownerType, 'platform');
  return db.select().from(coupons).where(where).orderBy(sql`${coupons.createdAt} desc`);
}

/** Owner-scoped fetch so a tenant can never read/patch another owner's coupon. */
export async function getOwnedCoupon(owner: CouponOwner, couponId: string): Promise<Coupon | null> {
  const where =
    owner.kind === 'tenant'
      ? and(eq(coupons.id, couponId), eq(coupons.ownerType, 'tenant'), eq(coupons.tenantId, owner.tenantId))
      : and(eq(coupons.id, couponId), eq(coupons.ownerType, 'platform'));
  const [row] = await db.select().from(coupons).where(where).limit(1);
  return row ?? null;
}

export interface UpdateCouponPatch {
  description?: string | null;
  minOrderPaise?: number | null;
  maxDiscountPaise?: number | null;
  visibility?: Coupon['visibility'];
  validFrom?: Date | null;
  validUntil?: Date | null;
  maxRedemptions?: number | null;
  perUserLimit?: number | null;
  status?: Coupon['status'];
}

export async function updateCoupon(
  ctx: AuditCtx,
  owner: CouponOwner,
  couponId: string,
  patch: UpdateCouponPatch,
): Promise<Coupon> {
  return db.transaction(async (tx) => {
    const existing = await getOwnedCoupon(owner, couponId);
    if (!existing) throw new NotFound('Coupon not found', 'coupon_not_found');
    const set: Partial<NewCoupon> = {};
    for (const k of [
      'description', 'minOrderPaise', 'maxDiscountPaise', 'visibility',
      'validFrom', 'validUntil', 'maxRedemptions', 'perUserLimit', 'status',
    ] as const) {
      if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
    }
    if (Object.keys(set).length > 0) {
      await tx.update(coupons).set(set).where(eq(coupons.id, couponId));
    }
    const [updated] = await tx.select().from(coupons).where(eq(coupons.id, couponId)).limit(1);
    await writeAudit(tx, ctx, 'coupon.updated', 'coupon', couponId, existing as unknown as Record<string, unknown>, set);
    return updated!;
  });
}

export async function deleteCoupon(ctx: AuditCtx, owner: CouponOwner, couponId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await getOwnedCoupon(owner, couponId);
    if (!existing) throw new NotFound('Coupon not found', 'coupon_not_found');
    await tx.delete(coupons).where(eq(coupons.id, couponId));
    await writeAudit(tx, ctx, 'coupon.deleted', 'coupon', couponId, existing as unknown as Record<string, unknown>, null);
  });
}

/**
 * Resolve a typed code for an item purchase. Looks among the item's tenant's
 * coupons + platform coupons; org-owned wins on an exact-code collision. Then
 * runs the pure validation + the per-user limit check (DB count). Returns the
 * coupon and its funder, or a typed error.
 */
export async function resolveCouponForCheckout(args: {
  code: string;
  tenantId: string;
  userId: string;
  basePaise: number;
  now: Date;
  item: CheckoutItem;
}): Promise<{ ok: true; coupon: Coupon; funder: 'org' | 'platform' } | { ok: false; code: CouponErrorCode }> {
  const code = args.code.trim();
  const rows = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.code, code),
        or(
          and(eq(coupons.ownerType, 'tenant'), eq(coupons.tenantId, args.tenantId)),
          and(eq(coupons.ownerType, 'platform'), isNull(coupons.tenantId)),
        ),
      ),
    );
  if (rows.length === 0) return { ok: false, code: 'coupon_not_found' };
  // Org-owned wins on collision.
  const coupon = rows.find((r) => r.ownerType === 'tenant') ?? rows[0]!;

  const base = validateCoupon(coupon, { basePaise: args.basePaise, now: args.now, item: args.item });
  if (!base.ok) return base;

  if (coupon.perUserLimit != null) {
    const countRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(couponRedemptions)
      .where(and(eq(couponRedemptions.couponId, coupon.id), eq(couponRedemptions.userId, args.userId)));
    const n = countRows[0]?.n ?? 0;
    if (n >= coupon.perUserLimit) return { ok: false, code: 'coupon_user_limit' };
  }

  return { ok: true, coupon, funder: coupon.ownerType === 'platform' ? 'platform' : 'org' };
}

export interface PricedItem {
  tenantId: string;
  basePaise: number;
  item: CheckoutItem;
}

/** Resolve base price + tenant + scope-item for a quote/booking request. */
export async function priceItem(req:
  | { itemType: 'event'; eventId: string }
  | { itemType: 'membership'; membershipId: string }
  | { itemType: 'slot'; slotIds: string[] },
): Promise<PricedItem> {
  if (req.itemType === 'event') {
    const [ev] = await db.select().from(events).where(eq(events.id, req.eventId)).limit(1);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');
    return { tenantId: ev.tenantId, basePaise: ev.pricePaise, item: { type: 'event', id: ev.id, venueId: ev.venueId } };
  }
  if (req.itemType === 'membership') {
    const [m] = await db.select().from(memberships).where(eq(memberships.id, req.membershipId)).limit(1);
    if (!m) throw new NotFound('Membership not found', 'membership_not_found');
    return { tenantId: m.tenantId, basePaise: m.pricePaise ?? 0, item: { type: 'membership', id: m.id, venueId: m.venueId ?? null } };
  }
  // slots: sum prices, all must share one arena + tenant
  const rows = await db.select().from(slots).where(inArray(slots.id, req.slotIds));
  if (rows.length === 0 || rows.length !== req.slotIds.length) throw new NotFound('Slot not found', 'slot_not_found');
  const arenaId = rows[0]!.arenaId;
  const tenantId = rows[0]!.tenantId;
  if (!rows.every((r) => r.arenaId === arenaId && r.tenantId === tenantId)) {
    throw new BadRequest('Slots must share one arena', 'multi_arena_booking');
  }
  const basePaise = rows.reduce((s, r) => s + r.pricePaise, 0);
  // Resolve the arena's venue so venue-scoped coupons can match a slot booking.
  const [arena] = await db.select().from(arenas).where(eq(arenas.id, arenaId)).limit(1);
  const venueId = arena?.venueId ?? null;
  return { tenantId, basePaise, item: { type: 'slot', id: arenaId, venueId } };
}

/**
 * Atomically bump redeemed_count (respecting max_redemptions) and insert the
 * redemption row, inside the caller's booking transaction. Throws Conflict if
 * the total cap is now exhausted (a lost race) so the booking rolls back.
 * `tx` is the transaction handle from db.transaction(async (tx) => …).
 */
export async function recordRedemption(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  args: {
    coupon: Coupon;
    bookingId: string;
    userId: string;
    tenantId: string;
    basePaise: number;
    discountPaise: number;
    funder: 'org' | 'platform';
  },
): Promise<void> {
  const bumped = await tx
    .update(coupons)
    .set({ redeemedCount: sql`${coupons.redeemedCount} + 1` })
    .where(
      and(
        eq(coupons.id, args.coupon.id),
        args.coupon.maxRedemptions != null
          ? sql`${coupons.redeemedCount} < ${args.coupon.maxRedemptions}`
          : sql`true`,
      ),
    )
    .returning({ id: coupons.id });
  if (bumped.length === 0) throw new Conflict('Coupon fully redeemed', 'coupon_max_redeemed');

  await tx.insert(couponRedemptions).values({
    couponId: args.coupon.id,
    bookingId: args.bookingId,
    userId: args.userId,
    tenantId: args.tenantId,
    basePaise: args.basePaise,
    discountPaise: args.discountPaise,
    funder: args.funder,
  });
}

/** Public, in-window coupons applicable to an item (for the offers picker). */
export async function listPublicCouponsForItem(priced: PricedItem, now: Date): Promise<Coupon[]> {
  const rows = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.visibility, 'public'),
        eq(coupons.status, 'active'),
        or(
          and(eq(coupons.ownerType, 'tenant'), eq(coupons.tenantId, priced.tenantId)),
          and(eq(coupons.ownerType, 'platform'), isNull(coupons.tenantId)),
        ),
      ),
    );
  return rows.filter((c) => validateCoupon(c, { basePaise: priced.basePaise, now, item: priced.item }).ok);
}
