import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { computeCheckout } from '../services/checkout_pricing.js';
import {
  listPublicCouponsForItem,
  priceItem,
  resolveCouponForCheckout,
} from '../services/coupon_service.js';

const itemSchema = z.union([
  z.object({ itemType: z.literal('event'), eventId: z.string().uuid() }),
  z.object({ itemType: z.literal('membership'), membershipId: z.string().uuid() }),
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

    if (!parsed.data.couponCode) {
      const b = computeCheckout(priced.basePaise, null);
      return { ...b, coupon: null };
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
      const b = computeCheckout(priced.basePaise, null);
      return { ...b, coupon: null, error: resolved.code };
    }
    const b = computeCheckout(priced.basePaise, {
      discountType: resolved.coupon.discountType,
      discountValue: resolved.coupon.discountValue,
      maxDiscountPaise: resolved.coupon.maxDiscountPaise,
    });
    return {
      ...b,
      coupon: { id: resolved.coupon.id, code: resolved.coupon.code, description: resolved.coupon.description },
    };
  });

  app.get('/v1/consumer/coupons', async (req) => {
    const q = z
      .union([
        z.object({ itemType: z.literal('event'), itemId: z.string().uuid() }),
        z.object({ itemType: z.literal('membership'), itemId: z.string().uuid() }),
      ])
      .safeParse(req.query);
    if (!q.success) throw new BadRequest('Invalid query', 'bad_request', { issues: q.error.issues });
    const priced =
      q.data.itemType === 'event'
        ? await priceItem({ itemType: 'event', eventId: q.data.itemId })
        : await priceItem({ itemType: 'membership', membershipId: q.data.itemId });
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
