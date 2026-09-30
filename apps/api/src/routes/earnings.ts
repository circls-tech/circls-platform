import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getTenantEarnings } from '../services/earnings_service.js';

/**
 * Partner-facing earnings: net payable for a window the partner chooses.
 *
 * Gated on `financials.read` — Owners, Managers and Read-only members, not
 * Staff, matching the role descriptions ("No team management or financial
 * reports"). A suspended organisation keeps it: `.read` capabilities survive
 * suspension, so a partner can always see what they are owed.
 *
 * The service returns net only, by design. See earnings_service for why gross
 * and commission are absent from the response rather than merely hidden by the
 * portal.
 */

/**
 * The window. Both bounds are required — there is no sensible default for
 * "what did I earn", and an open-ended scan of a busy organisation's whole
 * history is not something a page load should be able to ask for.
 *
 * Capped at 400 days so one request can cover a full financial year plus the
 * slack of a custom range, but not an unbounded sweep.
 */
const MAX_WINDOW_DAYS = 400;

const windowSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .refine((w) => new Date(w.from) < new Date(w.to), {
    message: 'from must be before to',
  })
  .refine(
    (w) => new Date(w.to).getTime() - new Date(w.from).getTime() <= MAX_WINDOW_DAYS * 86_400_000,
    { message: `window must be at most ${MAX_WINDOW_DAYS} days` },
  );

export const earningsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tenants/:tenantId/earnings', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'financials.read');

    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid earnings window', 'bad_request', {
        issues: parsed.error.issues,
      });
    }
    return getTenantEarnings(tenantId, parsed.data.from, parsed.data.to);
  });
};
