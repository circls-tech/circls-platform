/**
 * Billing config resolution — which commission / fee-split / advance rates
 * apply to a sale. Tenant-level knobs are the default; events may override
 * the per-listing rates (NULL = inherit, 0 = explicitly disabled).
 *
 * Callers that already hold the event row pass its override columns in —
 * this module never re-queries events, so resolution costs exactly one
 * PK-indexed tenants select.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenants } from '../db/schema/index.js';
import { NotFound } from '../lib/errors.js';
import type { BillingKnobs } from './checkout_pricing.js';

/** Same structural-exec trick as refund_service.RefundExec: `db` or a tx. */
export type BillingExec = Pick<typeof db, 'select'>;

/** The full resolved rate card for one sale. */
export interface ResolvedBillingConfig extends BillingKnobs {
  /** Partner-side commission bps (payout-time deduction). */
  partnerCommissionBps: number;
  /** Advance-payout bps of the charge's net (settle base − commission). */
  advancePayoutBps: number;
}

/** The per-event override columns (a slice of the events row). */
export interface EventBillingOverrides {
  partnerCommissionBps: number | null;
  consumerCommissionBps: number | null;
  advancePayoutBps: number | null;
}

export async function resolveBillingConfig(
  opts: { tenantId: string; eventOverrides?: EventBillingOverrides | null },
  exec: BillingExec = db,
): Promise<ResolvedBillingConfig> {
  const [t] = await exec
    .select({
      commissionBps: tenants.commissionBps,
      consumerCommissionBps: tenants.consumerCommissionBps,
      customerFeeShareBps: tenants.customerFeeShareBps,
      orgFeeShareBps: tenants.orgFeeShareBps,
      advancePayoutBps: tenants.advancePayoutBps,
    })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId))
    .limit(1);
  if (!t) throw new NotFound('Tenant not found', 'tenant_not_found');

  const ov = opts.eventOverrides;
  return {
    partnerCommissionBps: ov?.partnerCommissionBps ?? t.commissionBps,
    consumerCommissionBps: ov?.consumerCommissionBps ?? t.consumerCommissionBps,
    customerShareBps: t.customerFeeShareBps,
    orgShareBps: t.orgFeeShareBps,
    advancePayoutBps: ov?.advancePayoutBps ?? t.advancePayoutBps,
  };
}

/**
 * The per-charge money snapshot derived from a breakdown + resolved config.
 * Shared by all three charge paths (slots / events / memberships) so the
 * clamps can never diverge.
 *
 * @param preFeeSettleBasePaise The org's payout base before its gateway-fee
 *   share: full base for platform-funded-coupon sales, discounted base
 *   otherwise (the existing settleBase rule).
 */
export function computeChargeSnapshots(
  preFeeSettleBasePaise: number,
  breakdown: { orgFeeSharePaise: number; consumerCommissionPaise: number },
  billing: ResolvedBillingConfig,
): {
  settleBasePaise: number;
  partnerCommissionPaise: number;
  consumerCommissionPaise: number;
  advancePaise: number;
} {
  // Org bears its configured share of the gateway fee out of the settle base;
  // clamp for the tiny-base + Stripe-fixed-fee + high-orgShare corner.
  const settleBasePaise = Math.max(0, preFeeSettleBasePaise - breakdown.orgFeeSharePaise);
  // Partner commission on the PRE-fee base so the commission knob is
  // independent of the fee-split knob; clamped so no single charge can net
  // the partner negative.
  const partnerCommissionPaise = Math.min(
    Math.floor((preFeeSettleBasePaise * billing.partnerCommissionBps) / 10_000),
    settleBasePaise,
  );
  const advancePaise = Math.floor(
    ((settleBasePaise - partnerCommissionPaise) * billing.advancePayoutBps) / 10_000,
  );
  return {
    settleBasePaise,
    partnerCommissionPaise,
    consumerCommissionPaise: breakdown.consumerCommissionPaise,
    advancePaise,
  };
}

/**
 * The forensic rate-card blob stored in payments.metadata.billing — the org's
 * fee share is otherwise only implicit in the settle base, so keep it (and the
 * rates that produced every snapshot) auditable per charge.
 */
export function buildBillingMetadata(
  billing: ResolvedBillingConfig,
  amounts: { orgFeeSharePaise: number; gatewayFeeEstimatePaise: number },
): Record<string, number> {
  return {
    partnerCommissionBps: billing.partnerCommissionBps,
    consumerCommissionBps: billing.consumerCommissionBps,
    customerShareBps: billing.customerShareBps,
    orgShareBps: billing.orgShareBps,
    advancePayoutBps: billing.advancePayoutBps,
    orgFeeSharePaise: amounts.orgFeeSharePaise,
    gatewayFeeEstimatePaise: amounts.gatewayFeeEstimatePaise,
  };
}
