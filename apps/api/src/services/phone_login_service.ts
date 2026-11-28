import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { and, count, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { phoneLoginCodes } from '../db/schema/index.js';
import { BadRequest, Forbidden, RateLimit } from '../lib/errors.js';
import { createCustomToken, firebaseUserForPhone } from '../lib/firebase_admin.js';
import { logger } from '../lib/logger.js';
import { getLoginCodeSender } from '../lib/notifications/login_code.js';

/**
 * Consumer phone sign-in, split by country. Firebase phone auth bills $0.07
 * for every SMS to India, so with MSG91_OTP_ENABLED Indian numbers get a code
 * Circls generates, texts through MSG91 and checks here; the client then signs
 * in with a Firebase custom token for the number's own Firebase account. Every
 * other number, and every Indian one while the switch is off, still signs in
 * through Firebase phone auth on the client.
 *
 * Firebase used to stand between the public and the SMS bill (reCAPTCHA, its
 * own throttles). Here the limits below do: a cooldown and hourly cap per
 * number, an hourly cap per IP, a daily ceiling on the whole spend, and a cap
 * on wrong guesses per code. The IP and daily caps hand the sign-in back to
 * Firebase rather than refuse it: Indian carriers put many customers behind
 * one address, and a busy day is not an attack, so past them the customer
 * still signs in, with Firebase's reCAPTCHA in front, at Firebase's price.
 */

export const LOGIN_CODE_LENGTH = 6;
export const LOGIN_CODE_TTL_MIN = 10;
/** Matches the login page's Resend countdown. */
export const RESEND_COOLDOWN_SEC = 30;
export const MAX_SENDS_PER_PHONE_PER_HOUR = 5;
export const MAX_SENDS_PER_IP_PER_HOUR = 20;
export const MAX_ATTEMPTS_PER_CODE = 5;
/** Sent codes are kept this long as the send log, then purged. */
export const LOGIN_CODE_RETENTION_DAYS = 30;

/** An Indian mobile number in E.164: +91, then ten digits starting 6–9. */
const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;

export type PhoneLoginStart =
  | { provider: 'firebase' }
  | { provider: 'circls'; expiresInSec: number; resendAfterSec: number };

/** Whether Circls sends this number's code (else the client uses Firebase). */
export function circlsSendsCodeTo(phoneE164: string): boolean {
  return env.MSG91_OTP_ENABLED && phoneE164.startsWith('+91');
}

/**
 * A code is six digits and lives ten minutes, so a salt would add nothing a
 * stolen hash couldn't brute-force anyway; the hash just keeps codes out of
 * plain sight in the table.
 */
function hashCode(phoneE164: string, code: string): string {
  return createHash('sha256').update(`${phoneE164}:${code}`).digest('hex');
}

function codeMatches(phoneE164: string, storedHash: string, code: string): boolean {
  const a = Buffer.from(hashCode(phoneE164, code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Sends a login code when Circls handles this number, or tells the client to
 * use Firebase. Throws 400 `invalid_phone` for a +91 number that isn't an
 * Indian mobile, and 429 `rate_limited` within the resend cooldown or past the
 * number's hourly cap. Past the IP or daily cap, or when MSG91 fails, the
 * answer is Firebase.
 */
export async function startPhoneLogin(
  phoneE164: string,
  ip: string | null,
  now: Date = new Date(),
): Promise<PhoneLoginStart> {
  if (!circlsSendsCodeTo(phoneE164)) return { provider: 'firebase' };
  if (!INDIAN_MOBILE.test(phoneE164)) {
    throw new BadRequest('That phone number looks invalid. Check it and try again.', 'invalid_phone');
  }

  const code = String(randomInt(0, 10 ** LOGIN_CODE_LENGTH)).padStart(LOGIN_CODE_LENGTH, '0');
  const sender = getLoginCodeSender();
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - 24 * HOUR_MS);

  // Check the limits and record the send as one step per number, so a burst
  // of parallel requests can't all pass the checks before any is counted.
  const recorded = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${phoneE164}, 0))`);

    const [latest] = await tx
      .select({ createdAt: phoneLoginCodes.createdAt })
      .from(phoneLoginCodes)
      .where(eq(phoneLoginCodes.phoneE164, phoneE164))
      .orderBy(desc(phoneLoginCodes.createdAt))
      .limit(1);
    if (latest) {
      const waitSec = Math.ceil(
        (latest.createdAt.getTime() + RESEND_COOLDOWN_SEC * 1000 - now.getTime()) / 1000,
      );
      if (waitSec > 0) {
        throw new RateLimit(`Please wait ${waitSec}s before asking for another code.`, 'rate_limited', {
          retryAfterSec: waitSec,
        });
      }
    }

    const [perPhone] = await tx
      .select({ n: count() })
      .from(phoneLoginCodes)
      .where(and(eq(phoneLoginCodes.phoneE164, phoneE164), gt(phoneLoginCodes.createdAt, hourAgo)));
    if ((perPhone?.n ?? 0) >= MAX_SENDS_PER_PHONE_PER_HOUR) {
      throw new RateLimit('Too many codes sent to this number. Try again in an hour.', 'rate_limited');
    }

    if (ip) {
      const [perIp] = await tx
        .select({ n: count() })
        .from(phoneLoginCodes)
        .where(and(eq(phoneLoginCodes.ip, ip), gt(phoneLoginCodes.createdAt, hourAgo)));
      if ((perIp?.n ?? 0) >= MAX_SENDS_PER_IP_PER_HOUR) return 'ip_limit' as const;
    }

    const [perDay] = await tx
      .select({ n: count() })
      .from(phoneLoginCodes)
      .where(gt(phoneLoginCodes.createdAt, dayAgo));
    if ((perDay?.n ?? 0) >= env.LOGIN_OTP_DAILY_LIMIT) return 'daily_limit' as const;

    const [row] = await tx
      .insert(phoneLoginCodes)
      .values({
        phoneE164,
        codeHash: hashCode(phoneE164, code),
        provider: sender.mode,
        ip,
        expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MIN * 60 * 1000),
        createdAt: now,
      })
      .returning({ id: phoneLoginCodes.id });
    return row!;
  });

  if (recorded === 'ip_limit' || recorded === 'daily_limit') {
    logger.warn({ ip, limit: recorded }, 'login_code_limit_reached');
    return { provider: 'firebase' };
  }

  try {
    const { requestId } = await sender.send({ phoneE164, code, ttlMinutes: LOGIN_CODE_TTL_MIN });
    if (requestId) {
      await db
        .update(phoneLoginCodes)
        .set({ providerRequestId: requestId })
        .where(eq(phoneLoginCodes.id, recorded.id));
    }
  } catch (err) {
    // Nothing was texted: drop the row so it neither counts against the
    // number nor stands as its live code, and let Firebase send this one.
    logger.error({ err }, 'login_code_send_failed');
    await db.delete(phoneLoginCodes).where(eq(phoneLoginCodes.id, recorded.id));
    return { provider: 'firebase' };
  }

  return {
    provider: 'circls',
    expiresInSec: LOGIN_CODE_TTL_MIN * 60,
    resendAfterSec: RESEND_COOLDOWN_SEC,
  };
}

/**
 * Checks a code from startPhoneLogin and returns a Firebase custom token for
 * the number's account. Only the number's newest code counts. Throws 400
 * `code_expired` (none live: expired, used, or replaced by a newer one), 400
 * `invalid_code` (wrong; `attemptsLeft` in details), 429 `too_many_attempts`
 * once a code has had its guesses, 403 `account_disabled`.
 */
export async function verifyPhoneLogin(
  phoneE164: string,
  code: string,
  now: Date = new Date(),
): Promise<{ customToken: string }> {
  const [row] = await db
    .select()
    .from(phoneLoginCodes)
    .where(eq(phoneLoginCodes.phoneE164, phoneE164))
    .orderBy(desc(phoneLoginCodes.createdAt))
    .limit(1);
  if (!row || row.usedAt || row.expiresAt <= now) {
    throw new BadRequest('That code has expired. Request a new one.', 'code_expired');
  }

  // Count the guess before judging it, atomically, so parallel guesses can't
  // get past the cap.
  const [counted] = await db
    .update(phoneLoginCodes)
    .set({ attempts: sql`${phoneLoginCodes.attempts} + 1` })
    .where(and(eq(phoneLoginCodes.id, row.id), lt(phoneLoginCodes.attempts, MAX_ATTEMPTS_PER_CODE)))
    .returning({ attempts: phoneLoginCodes.attempts });
  if (!counted) {
    throw new RateLimit('Too many wrong codes. Request a new one.', 'too_many_attempts');
  }
  if (!codeMatches(phoneE164, row.codeHash, code)) {
    const attemptsLeft = MAX_ATTEMPTS_PER_CODE - counted.attempts;
    if (attemptsLeft <= 0) {
      throw new RateLimit('Too many wrong codes. Request a new one.', 'too_many_attempts');
    }
    throw new BadRequest('That code is incorrect. Please try again.', 'invalid_code', { attemptsLeft });
  }

  // Single use: of two requests racing with the right code, one signs in.
  const [claimed] = await db
    .update(phoneLoginCodes)
    .set({ usedAt: now })
    .where(and(eq(phoneLoginCodes.id, row.id), isNull(phoneLoginCodes.usedAt)))
    .returning({ id: phoneLoginCodes.id });
  if (!claimed) {
    throw new BadRequest('That code has expired. Request a new one.', 'code_expired');
  }

  const user = await firebaseUserForPhone(phoneE164);
  if (user.disabled) {
    throw new Forbidden('This account has been disabled.', 'account_disabled');
  }
  return { customToken: await createCustomToken(user.uid) };
}

/** Drops sent codes older than the retention window. Returns how many. */
export async function purgeOldPhoneLoginCodes(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - LOGIN_CODE_RETENTION_DAYS * 24 * HOUR_MS);
  const deleted = await db
    .delete(phoneLoginCodes)
    .where(lt(phoneLoginCodes.createdAt, cutoff))
    .returning({ id: phoneLoginCodes.id });
  return deleted.length;
}
