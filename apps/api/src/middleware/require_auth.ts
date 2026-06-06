import type { DecodedIdToken } from 'firebase-admin/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Unauthorized } from '../lib/errors.js';
import { verifyIdToken } from '../lib/firebase_admin.js';

export interface AuthUser {
  firebaseUid: string;
  phoneE164: string | null;
  email: string | null;
  claims: DecodedIdToken;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

/**
 * Fastify preHandler: verifies the `Authorization: Bearer <firebase-jwt>` header
 * and attaches `req.authUser`. Throws `Unauthorized` (401 `auth_required`) on any
 * missing/invalid token.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new Unauthorized();
  }
  const token = header.slice('Bearer '.length).trim();
  let decoded: DecodedIdToken;
  try {
    decoded = await verifyIdToken(token);
  } catch (err) {
    req.log.warn({ err }, 'token_verification_failed');
    throw new Unauthorized();
  }
  req.authUser = {
    firebaseUid: decoded.uid,
    phoneE164: decoded.phone_number ?? null,
    // SECURITY (C1): only trust the email claim when Firebase has verified ownership.
    // An unverified email must never become an identity key (adoptStaleIdentity matches
    // on it). Firebase phone-auth numbers are inherently verified, so phone is unchanged.
    email: decoded.email_verified ? (decoded.email ?? null) : null,
    claims: decoded,
  };
}
