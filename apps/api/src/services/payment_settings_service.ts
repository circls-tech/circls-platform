/**
 * Runtime payment settings a platform admin controls from the admin portal
 * (Payments page) — today, which gateway NEW INR orders go to. The manual
 * failover switch: flip INR from Cashfree to Razorpay (or back) without a
 * redeploy. Unset, the server default decides: INR_PAYMENT_GATEWAY, else
 * Cashfree when its keys are configured (config/env.ts).
 *
 * Switching only affects new orders: refunds, cancels and webhooks follow the
 * provider stored on each charge row (see lib/gateway.ts).
 */
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { platformSettings } from '../db/schema/index.js';
import { writeAudit } from '../lib/audit.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { getCashfree } from '../lib/cashfree.js';
import { Conflict } from '../lib/errors.js';
import { cashfreeFailoverState, type CashfreeFailoverState } from '../lib/inr_failover.js';
import { getRazorpay } from '../lib/razorpay.js';

export type InrGateway = 'razorpay' | 'cashfree';

const INR_GATEWAY_KEY = 'inr_payment_gateway';

/** Bookings read the setting on every order; a short cache keeps that free. */
const CACHE_MS = 15_000;
let cached: { gateway: InrGateway | null; at: number } | null = null;

function parseGateway(value: unknown): InrGateway | null {
  return value === 'razorpay' || value === 'cashfree' ? value : null;
}

async function readSetting(): Promise<typeof platformSettings.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, INR_GATEWAY_KEY))
    .limit(1);
  return row;
}

/** The gateway new INR orders go to: the admin's choice, else the env default. */
export async function getInrPaymentGateway(now: number = Date.now()): Promise<InrGateway> {
  if (!cached || now - cached.at > CACHE_MS) {
    const row = await readSetting();
    cached = { gateway: parseGateway(row?.value), at: now };
  }
  return cached.gateway ?? env.INR_PAYMENT_GATEWAY;
}

export interface PaymentSettingsView {
  inrGateway: InrGateway;
  /** 'admin' when a platform admin chose it; 'env' when it's the deploy default. */
  source: 'admin' | 'env';
  envDefault: InrGateway;
  updatedAt: string | null;
  updatedByUserId: string | null;
  /** Whether each INR gateway has live keys. Stub = payments not enabled. */
  gateways: {
    razorpay: { mode: 'live' | 'stub' };
    cashfree: { mode: 'live' | 'stub'; environment: 'sandbox' | 'production' };
  };
  /** Automatic failover from Cashfree to Razorpay (lib/inr_failover), and its trigger. */
  failover: CashfreeFailoverState & { threshold: number; windowSec: number; cooldownSec: number };
}

export async function getPaymentSettings(): Promise<PaymentSettingsView> {
  const row = await readSetting();
  const chosen = parseGateway(row?.value);
  return {
    inrGateway: chosen ?? env.INR_PAYMENT_GATEWAY,
    source: chosen ? 'admin' : 'env',
    envDefault: env.INR_PAYMENT_GATEWAY,
    updatedAt: chosen && row ? row.updatedAt.toISOString() : null,
    updatedByUserId: chosen ? (row?.updatedByUserId ?? null) : null,
    gateways: {
      razorpay: { mode: getRazorpay().mode },
      cashfree: { mode: getCashfree().mode, environment: env.CASHFREE_ENV },
    },
    failover: {
      ...cashfreeFailoverState(),
      threshold: env.INR_FAILOVER_THRESHOLD,
      windowSec: env.INR_FAILOVER_WINDOW_SEC,
      cooldownSec: env.INR_FAILOVER_COOLDOWN_SEC,
    },
  };
}

/**
 * Point new INR orders at `gateway`. Refuses to route INR to a gateway
 * without live keys in production — every Indian checkout would otherwise
 * silently turn into an unpaid "reserved" booking.
 */
export async function setInrPaymentGateway(
  gateway: InrGateway,
  actorUserId: string,
): Promise<PaymentSettingsView> {
  const adapter = gateway === 'cashfree' ? getCashfree() : getRazorpay();
  if (env.NODE_ENV === 'production' && adapter.mode !== 'live') {
    throw new Conflict(
      `${gateway === 'cashfree' ? 'Cashfree' : 'Razorpay'} is not configured on this server`,
      'gateway_not_configured',
    );
  }

  const before = await readSetting();
  await db
    .insert(platformSettings)
    .values({ key: INR_GATEWAY_KEY, value: gateway, updatedByUserId: actorUserId })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: gateway, updatedByUserId: actorUserId, updatedAt: new Date() },
    });
  cached = null;

  const platformTenantId = await getPlatformTenantId();
  await writeAudit(
    db,
    { tenantId: platformTenantId, actorUserId },
    'platform.inr_gateway_changed',
    'platform',
    platformTenantId,
    { inrGateway: parseGateway(before?.value) ?? env.INR_PAYMENT_GATEWAY },
    { inrGateway: gateway },
  );
  return getPaymentSettings();
}

/** Test-only: forget the cached setting. */
export function __resetPaymentSettingsCacheForTesting(): void {
  cached = null;
}
