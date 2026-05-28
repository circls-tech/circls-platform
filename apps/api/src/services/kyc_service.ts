/**
 * KYC service stub — Phase 11 owner fills these in.
 *
 * Contract pinned here so the worker & routes compile:
 *   - pollKycStatuses(): worker handler. Returns the count of tenants polled.
 *   - submitKyc(): route handler called by POST /v1/tenants/:id/kyc.
 *   - getKycStatus(): route handler called by GET /v1/tenants/:id/kyc.
 */
import { db } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { tenants } from '../db/schema/tenants.js';
import { logger } from '../lib/logger.js';
import type { KycSubmission } from '../lib/razorpay.js';

export interface KycSubmitResult {
  tenantId: string;
  linkedAccountId: string;
  status: 'submitted' | 'in_review' | 'verified' | 'rejected';
}

export async function submitKyc(
  _tenantId: string,
  _actorUserId: string,
  _input: KycSubmission,
): Promise<KycSubmitResult> {
  throw new Error('kyc_service.submitKyc not implemented — phase 11');
}

export async function getKycStatus(tenantId: string): Promise<{
  status: string;
  submittedAt: Date | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  razorpayLinkedAccountId: string | null;
}> {
  const [row] = await db
    .select({
      status: tenants.kycStatus,
      submittedAt: tenants.kycSubmittedAt,
      verifiedAt: tenants.kycVerifiedAt,
      rejectionReason: tenants.kycRejectionReason,
      razorpayLinkedAccountId: tenants.razorpayLinkedAccountId,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new Error('tenant_not_found');
  return row;
}

/** Called by the `kyc-status-poll` worker every 30 minutes. */
export async function pollKycStatuses(): Promise<number> {
  // TODO(phase-11): SELECT tenants with kyc_status IN ('submitted', 'in_review').
  // For each, call razorpay.fetchLinkedAccount() and update kyc_status accordingly.
  // Write an audit row per state transition.
  logger.debug('kyc_status_poll_stub');
  return 0;
}
