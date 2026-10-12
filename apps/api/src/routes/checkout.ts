import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { checkoutGatewaysOf } from '../lib/gateway.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { type CheckoutBreakdown, computeCheckout } from '../services/checkout_pricing.js';
import { resolveBillingConfig } from '../services/billing_config.js';
import { resolvePaymentContext } from '../services/payments_service.js';
import {
  MAX_LINES_PER_EVENT_BOOKING,
  MAX_SLOTS_PER_BOOKING,
  MAX_TICKETS_PER_LINE,
} from '../lib/booking_limits.js';
import {
  listPublicCouponsForItem,
  priceItem,
  resolveCouponForCheckout,
} from '../services/coupon_service.js';

const itemSchema = z.union([
  z.object({
    itemType: z.literal('event'),
    eventId: z.string().uuid(),
    lines: z
      .array(
        z.object({
          tierId: z.string().uuid(),
          quantity: z.number().int().min(1).max(MAX_TICKETS_PER_LINE),
        }),
      )
      .min(1)
      .max(MAX_LINES_PER_EVENT_BOOKING),
  }),
  z.object({
    itemType: z.literal('membership'),
    membershipId: z.string().uuid(),
    membershipTierId: z.string().uuid().optional(),
  }),
  z.object({
    itemType: z.literal('slot'),
    slotIds: z.array(z.string().uuid()).min(1).max(MAX_SLOTS_PER_BOOKING),
  }),
]);
const quoteBody = z.intersection(itemSchema, z.object({ couponCode: z.string().min(1).max(64).optional() }));

/**
 * A venue cart's slot ids on the offers-listing query string: either a
 * comma-separated `slotIds=a,b` or repeated `slotIds=a&slotIds=b` (Fastify
 * hands the latter over as an array).
 *
 * Capped because this route takes no auth: each id widens two `in (…)` scans,
 * and an uncapped array is a free fan-out for anyone. The cap is the one the
 * quote and booking paths enforce, so any cart that can be booked gets its
 * offers listed.
 */
const MAX_LISTED_CART_SLOTS = MAX_SLOTS_PER_BOOKING;

const slotIdsQuery = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.string().uuid()).min(1).max(MAX_LISTED_CART_SLOTS));

/** The money fields a quote response exposes to consumers. */
interface QuoteMoneyFields {
  basePaise: number;
  discountPaise: number;
  discountedBasePaise: number;
  otherChargesPaise: number;
  totalPaise: number;
  gatewayFeePaise: number;
  gatewayFeeWaivedPaise: number;
  platformFeePaise: number;
}

/**
 * Consumer-safe slice of a breakdown. Deliberately a whitelist, never a
 * spread: `orgFeeSharePaise` / `gatewayFeeEstimatePaise` are org-billing data
 * and must not leak to consumers. `otherChargesPaise` keeps its historical
 * meaning (total − discountedBase) and now equals gatewayFee + platformFee —
 * `gatewayFeePaise` / `platformFeePaise` feed the checkout tooltip's split,
 * and `gatewayFeeWaivedPaise` is the part of the gateway fee the customer is
 * not charged (rendered struck through / "FREE").
 */
function quoteFields(b: CheckoutBreakdown): QuoteMoneyFields {
  return {
    basePaise: b.basePaise,
    discountPaise: b.discountPaise,
    discountedBasePaise: b.discountedBasePaise,
    otherChargesPaise: b.otherChargesPaise,
    totalPaise: b.totalPaise,
    gatewayFeePaise: b.gatewayFeeCustomerPaise,
    gatewayFeeWaivedPaise: b.gatewayFeeWaivedPaise,
    platformFeePaise: b.consumerCommissionPaise,
  };
}

export const checkoutRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/consumer/checkout/quote', { preHandler: requireAuth }, async (req) => {
    const parsed = quoteBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequest('Invalid quote payload', 'bad_request', { issues: parsed.error.issues });
    const user = await currentUser(req);
    const now = new Date();
    const priced = await priceItem(parsed.data);

    // The gross-up ("other charges") is gateway-specific; quote with the same
    // gateway the booking will charge through so the two can never diverge.
    const payCtx = await resolvePaymentContext({
      venueId: priced.item.venueId,
      tenantId: priced.tenantId,
      checkoutGateways: checkoutGatewaysOf(req.headers),
    });

    // Same billing knobs the booking path will resolve, so quote and charge
    // can never diverge.
    const billing = await resolveBillingConfig({
      tenantId: priced.tenantId,
      eventOverrides: priced.eventBillingOverrides ?? null,
    });

    if (!parsed.data.couponCode) {
      const b = computeCheckout(priced.basePaise, null, payCtx.provider, billing);
      return { ...quoteFields(b), currency: payCtx.currency, coupon: null };
    }
    const resolved = await resolveCouponForCheckout({
      code: parsed.data.couponCode,
      tenantId: priced.tenantId,
      userId: user.id,
      basePaise: priced.basePaise,
      now,
      item: priced.item,
    });
    if (!resolved.ok) {
      const b = computeCheckout(priced.basePaise, null, payCtx.provider, billing);
      return { ...quoteFields(b), currency: payCtx.currency, coupon: null, error: resolved.code };
    }
    const b = computeCheckout(
      priced.basePaise,
      {
        discountType: resolved.coupon.discountType,
        discountValue: resolved.coupon.discountValue,
        maxDiscountPaise: resolved.coupon.maxDiscountPaise,
      },
      payCtx.provider,
      billing,
    );
    return {
      ...quoteFields(b),
      currency: payCtx.currency,
      coupon: { id: resolved.coupon.id, code: resolved.coupon.code, description: resolved.coupon.description },
    };
  });

  app.get('/v1/consumer/coupons', async (req) => {
    const q = z
      .union([
        z.object({ itemType: z.literal('event'), itemId: z.string().uuid() }),
        z.object({ itemType: z.literal('membership'), itemId: z.string().uuid() }),
        z.object({ itemType: z.literal('slot'), slotIds: slotIdsQuery }),
      ])
      .safeParse(req.query);
    if (!q.success) throw new BadRequest('Invalid query', 'bad_request', { issues: q.error.issues });
    const priced =
      q.data.itemType === 'event'
        ? await priceItem({ itemType: 'event', eventId: q.data.itemId })
        : q.data.itemType === 'membership'
          ? await priceItem({ itemType: 'membership', membershipId: q.data.itemId })
          : await priceItem({ itemType: 'slot', slotIds: q.data.slotIds });
    const rows = await listPublicCouponsForItem(priced, new Date());
    return {
      rows: rows.map((c) => ({
        code: c.code,
        description: c.description,
        discountType: c.discountType,
        discountValue: c.discountValue,
        maxDiscountPaise: c.maxDiscountPaise,
        minOrderPaise: c.minOrderPaise,
      })),
    };
  });
};
