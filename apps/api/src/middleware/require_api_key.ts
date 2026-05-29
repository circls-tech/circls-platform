import type { FastifyReply, FastifyRequest } from 'fastify';
import { Unauthorized } from '../lib/errors.js';
import { verifyApiKey } from '../services/api_keys_service.js';
import type { ApiKey } from '../db/schema/api_keys.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireApiKey` middleware. */
    apiKey?: ApiKey | null;
    /** Convenience: `apiKey.tenantId` (may be null for platform keys). */
    apiTenantId?: string | null;
  }
}

/**
 * Fastify preHandler that authenticates a request using a Circls API key.
 *
 * Expects `Authorization: Bearer ck_…`. Looks the key up via
 * `api_keys_service.verifyApiKey` (prefix-indexed SELECT + bcrypt compare).
 * On success: attaches `req.apiKey` and `req.apiTenantId`. On failure: 401.
 *
 * Use `app.decorateRequest('apiKey', null)` once at server build for fastify v5
 * performance reasons.
 */
export async function requireApiKey(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new Unauthorized('API key required', 'api_key_required');
  }
  const token = header.slice('Bearer '.length).trim();
  // Quick sanity check before hitting the DB.
  if (!token.startsWith('ck_')) {
    throw new Unauthorized('Invalid API key', 'api_key_invalid');
  }
  const key = await verifyApiKey(token);
  if (!key) {
    throw new Unauthorized('Invalid API key', 'api_key_invalid');
  }
  req.apiKey = key;
  req.apiTenantId = key.tenantId;
}
