import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { switchCheckoutGateway, verifyCheckoutPayment } from '../services/payment_recovery_service.js';

const orderParams = z.object({ orderId: z.string().min(1).max(100) });

/**
 * The checkout's view of its own payment, by gateway order id. Only the
 * booking's customer can read or act on it (anything else is a 404).
 *
 *   GET  /v1/consumer/payments/:orderId/status
 *     → { status: 'paid' | 'pending' | 'failed' | 'expired' } (see
 *       CheckoutPaymentStatus). For a pending Cashfree charge this asks
 *       Cashfree directly, so a paid booking is confirmed even before (or
 *       without) its webhook, and a declined attempt shows as 'failed'.
 *   POST /v1/consumer/payments/:orderId/switch-gateway
 *     → { outcome: 'paid' } | { outcome: 'switched', payment }. "Try another
 *       way to pay": replaces a pending Cashfree order with a Razorpay one.
 */
export const consumerPaymentRoutes: FastifyPluginAsync = async (app) => {
  const publicLimit = {
    rateLimit: { max: env.RATE_LIMIT_PUBLIC_MAX, timeWindow: '1 minute' },
  } as const;

  app.get(
    '/v1/consumer/payments/:orderId/status',
    { preHandler: requireAuth, config: publicLimit },
    async (req) => {
      const parsed = orderParams.safeParse(req.params);
      if (!parsed.success) throw new BadRequest('Invalid order id', 'bad_request');
      const user = await currentUser(req);
      return verifyCheckoutPayment({ userId: user.id, orderId: parsed.data.orderId });
    },
  );

  app.post(
    '/v1/consumer/payments/:orderId/switch-gateway',
    { preHandler: requireAuth, config: publicLimit },
    async (req) => {
      const parsed = orderParams.safeParse(req.params);
      if (!parsed.success) throw new BadRequest('Invalid order id', 'bad_request');
      const user = await currentUser(req);
      return switchCheckoutGateway({ userId: user.id, orderId: parsed.data.orderId });
    },
  );
};
