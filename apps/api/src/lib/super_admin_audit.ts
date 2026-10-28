import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';
import { writeAudit } from './audit.js';
import {
  newRequestAuditContext,
  type RequestAuditContext,
  runWithRequestAuditContext,
} from './request_audit_context.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestAudit: RequestAuditContext | null;
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Write routes that change nothing in the org: a customer-view preview, a
 * signed upload URL (the upload is recorded when it's finalised), a ticket
 * look-up at the door (a consumed scan audits itself).
 */
const NON_CHANGING_ROUTES = new Set([
  '/v1/tenants/:tenantId/listings/:type/:id/preview',
  '/v1/venues/:id/images/upload-presign',
  '/v1/events/:id/images/upload-presign',
  '/v1/tenants/:id/logo/upload-presign',
  '/v1/tenants/:tenantId/qr-tickets/validate',
]);

/**
 * Every successful change a Circls super admin makes in a partner org lands
 * in that org's Activity Log. Most changes audit themselves; for the rest
 * (venues, photos, schedules, prices…) this writes one
 * `tenant.super_admin_change` row naming the request, before the response
 * goes out.
 */
export function registerSuperAdminAudit(app: FastifyInstance): void {
  app.decorateRequest('requestAudit', null);

  // preValidation, not onRequest: the context then survives body parsing.
  app.addHook('preValidation', (req, _reply, done) => {
    if (!WRITE_METHODS.has(req.method)) {
      done();
      return;
    }
    const ctx = newRequestAuditContext();
    req.requestAudit = ctx;
    runWithRequestAuditContext(ctx, done);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const ctx = req.requestAudit;
    if (!ctx?.superAdminUserId || reply.statusCode >= 400) return payload;
    const route = req.routeOptions.url;
    if (!route || NON_CHANGING_ROUTES.has(route)) return payload;
    for (const tenantId of ctx.superAdminTenantIds) {
      if (ctx.auditedTenantIds.has(tenantId)) continue;
      try {
        await writeAudit(
          db,
          { tenantId, actorUserId: ctx.superAdminUserId },
          'tenant.super_admin_change',
          'tenant',
          tenantId,
          null,
          { request: `${req.method} ${route}`, params: req.params as Record<string, unknown> },
        );
      } catch (err) {
        // The change itself went through; a missing log line mustn't fail it.
        req.log.error({ err, tenantId }, 'super_admin_change_audit_failed');
      }
    }
    return payload;
  });
}
