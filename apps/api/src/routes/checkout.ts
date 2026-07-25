import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { computeCheckout } from '../services/checkout_pricing.js';
import { resolvePaymentContext } from '../services/payments_service.js';
import {
  listPublicCouponsForItem,
  priceItem,
  resolveCouponForCheckout,
} from '../services/coupon_service.js';

const itemSchema = z.union([
  z.object({
    itemType: z.literal('event'),
    eventId: z.string().uuid(),
    lines: z.array(z.object({ tierId: z.string().uuid(), quantity: z.number().int().min(1) })).min(1),
  }),
  z.object({
    itemType: z.literal('membership'),
    membershipId: z.string().uuid(),
    membershipTierId: z.string().uuid().optional(),
  }),
  z.object({ itemType: z.literal('slot'), slotIds: z.array(z.string().uuid()).min(1) }),
]);
const quoteBody = z.intersection(itemSchema, z.object({ couponCode: z.string().min(1).max(64).optional() }));

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
    });

    if (!parsed.data.couponCode) {
      const b = computeCheckout(priced.basePaise, null, payCtx.provider);
      return { ...b, currency: payCtx.currency, coupon: null };
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
      const b = computeCheckout(priced.basePaise, null, payCtx.provider);
      return { ...b, currency: payCtx.currency, coupon: null, error: resolved.code };
    }
    const b = computeCheckout(
      priced.basePaise,
      {
        discountType: resolved.coupon.discountType,
        discountValue: resolved.coupon.discountValue,
        maxDiscountPaise: resolved.coupon.maxDiscountPaise,
      },
      payCtx.provider,
    );
    return {
      ...b,
      currency: payCtx.currency,
      coupon: { id: resolved.coupon.id, code: resolved.coupon.code, description: resolved.coupon.description },
    };
  });

  app.get('/v1/consumer/coupons', async (req) => {
    const q = z
      .union([
        z.object({ itemType: z.literal('event'), itemId: z.string().uuid() }),
        z.object({ itemType: z.literal('membership'), itemId: z.string().uuid() }),
        // Slot carts (venue court bookings): comma-separated slot ids.
        z.object({ itemType: z.literal('slot'), slotIds: z.string().min(1) }),
      ])
      .safeParse(req.query);
    if (!q.success) throw new BadRequest('Invalid query', 'bad_request', { issues: q.error.issues });
    let priced;
    if (q.data.itemType === 'slot') {
      const ids = z
        .array(z.string().uuid())
        .min(1)
        .max(50)
        .safeParse(q.data.slotIds.split(',').map((s) => s.trim()).filter(Boolean));
      if (!ids.success) throw new BadRequest('Invalid slotIds', 'bad_request', { issues: ids.error.issues });
      priced = await priceItem({ itemType: 'slot', slotIds: ids.data });
    } else {
      priced =
        q.data.itemType === 'event'
          ? await priceItem({ itemType: 'event', eventId: q.data.itemId })
          : await priceItem({ itemType: 'membership', membershipId: q.data.itemId });
    }
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
