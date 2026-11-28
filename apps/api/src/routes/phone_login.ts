import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { startPhoneLogin, verifyPhoneLogin } from '../services/phone_login_service.js';

const phone = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Use the full number with country code, e.g. +919876543210');

const startBody = z.object({ phone });
// Any typo in the code is a wrong code (and counts as a guess), not a 400.
const verifyBody = z.object({ phone, code: z.string().trim().min(1).max(20) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequest('Invalid payload', 'bad_request', { issues: parsed.error.issues });
  }
  return parsed.data;
}

/**
 * Consumer phone sign-in, before there is a session (so unauthenticated).
 * The client asks `start` first: `{ provider: 'firebase' }` means carry on
 * with Firebase phone auth as before; `{ provider: 'circls' }` means a code
 * is on its way, to be sent back to `verify`, which answers with a Firebase
 * custom token for `signInWithCustomToken`. See services/phone_login_service.ts
 * for which numbers Circls texts and the limits on it. The per-route ceilings
 * here only stop hammering: one address can be a whole carrier's customers.
 */
export const phoneLoginRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/auth/phone/start',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(startBody, req.body);
      return startPhoneLogin(body.phone, req.ip ?? null);
    },
  );

  app.post(
    '/v1/auth/phone/verify',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(verifyBody, req.body);
      return verifyPhoneLogin(body.phone, body.code);
    },
  );
};
