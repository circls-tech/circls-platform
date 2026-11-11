import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { assertTenantActive } from '../middleware/require_cap.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { type QrScanSubject, validateQrTicket } from '../services/qr_ticket_service.js';

/**
 * Exactly one subject: the scanned `code`, or — for a desk lookup by name,
 * where staff have the booking or membership in front of them but never the
 * code — the `bookingId` / `userMembershipId` the pass belongs to.
 */
export const qrValidateBodySchema = z
  .object({
    code: z.string().min(1).max(200).optional(),
    bookingId: z.string().uuid().optional(),
    userMembershipId: z.string().uuid().optional(),
    /** false = peek without spending a scan (default true). */
    consume: z.boolean().optional(),
  })
  .refine(
    (b) => [b.code, b.bookingId, b.userMembershipId].filter((v) => v !== undefined).length === 1,
    { message: 'Send exactly one of code, bookingId or userMembershipId' },
  );

export function qrScanSubjectOf(body: z.infer<typeof qrValidateBodySchema>): QrScanSubject {
  if (body.code !== undefined) return { code: body.code };
  if (body.bookingId !== undefined) return { bookingId: body.bookingId };
  return { userMembershipId: body.userMembershipId! };
}

/**
 * Door check-in: validate (and by default consume) a QR ticket, found by its
 * scanned code or by the booking / membership it was issued for. Any member of
 * the tenant can scan, Read-only included, so no capability gates it; a
 * suspended tenant can still look a pass up but not admit anyone. Codes and
 * ids from other tenants read as not_found, so the endpoint can't be used to
 * probe foreign tickets.
 */
export const qrTicketRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/tenants/:tenantId/qr-tickets/validate',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      const parsed = qrValidateBodySchema.safeParse(req.body);
      if (!parsed.success)
        throw new BadRequest('Invalid scan payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      if (parsed.data.consume ?? true) assertTenantActive(ctx);
      return validateQrTicket({ tenantId, actorUserId: user.id }, qrScanSubjectOf(parsed.data), {
        consume: parsed.data.consume ?? true,
      });
    },
  );
};
