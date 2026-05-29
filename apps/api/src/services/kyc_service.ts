/**
 * KYC service — Phase 11 (Track B).
 *
 * Submission flow: the partner-portal POSTs the KYC bundle to
 * `POST /v1/tenants/:id/kyc`. We validate the tenant has not already submitted,
 * call the Razorpay adapter to create a Linked Account, persist the resulting
 * `razorpay_linked_account_id` + bank/PAN/legal-name columns, flip
 * `kyc_status` to `submitted`, and emit an audit row.
 *
 * Polling: the worker calls `pollKycStatuses()` every 30 minutes. We fetch all
 * tenants in `submitted` or `in_review` and consult the Razorpay adapter for
 * the live state. On a transition we update `kyc_status` (+ `kyc_verified_at`
 * if newly verified), and emit an audit row per transition.
 *
 * The Razorpay calls go through `getRazorpay()`. In dev/test (no
 * `RAZORPAY_KEY_*` env), the stub adapter returns deterministic ids — no
 * network. The Live adapter's `createLinkedAccount` / `fetchLinkedAccount`
 * bodies live in `lib/razorpay.ts` (currently `throw not implemented`) and
 * will be wired up by a future ops pass once test-mode keys exist.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog } from '../db/schema/audit_log.js';
import { tenants } from '../db/schema/tenants.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { writeAudit } from '../lib/audit.js';
import { getRazorpay, type KycSubmission, type LinkedAccount } from '../lib/razorpay.js';

export interface KycSubmitResult {
  tenantId: string;
  linkedAccountId: string;
  status: 'submitted' | 'in_review' | 'verified' | 'rejected';
}

/** Translate Razorpay's terms to ours. Returns null when the Razorpay state
 *  is `created` (which we map to "still submitted" — no transition). */
function mapRazorpayStatus(
  status: LinkedAccount['status'],
): 'submitted' | 'in_review' | 'verified' | 'rejected' | null {
  switch (status) {
    case 'activated':
      return 'verified';
    case 'under_review':
      return 'in_review';
    case 'rejected':
      return 'rejected';
    case 'created':
      // Razorpay hasn't started reviewing yet; keep whatever we already have.
      return null;
    default:
      return null;
  }
}

export async function submitKyc(
  tenantId: string,
  actorUserId: string,
  input: KycSubmission,
): Promise<KycSubmitResult> {
  const [existing] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!existing) throw new NotFound('Tenant not found', 'tenant_not_found');
  if (existing.kycStatus !== 'not_started') {
    throw new Conflict('KYC already submitted', 'kyc_already_submitted', {
      currentStatus: existing.kycStatus,
    });
  }

  // Create the Linked Account first — if Razorpay rejects the payload we
  // surface the error before touching our own row. The Live adapter (when
  // wired) will throw an `Upstream` AppError; the stub always succeeds.
  const linked = await getRazorpay().createLinkedAccount(input);

  const before = {
    kycStatus: existing.kycStatus,
    legalEntityName: existing.legalEntityName,
    panNumber: existing.panNumber,
    bankAccountNumber: existing.bankAccountNumber,
    bankIfsc: existing.bankIfsc,
    bankAccountHolderName: existing.bankAccountHolderName,
    razorpayLinkedAccountId: existing.razorpayLinkedAccountId,
  };

  const submittedAt = new Date();
  const [updated] = await db
    .update(tenants)
    .set({
      legalEntityName: input.legalName,
      panNumber: input.pan ?? null,
      bankAccountNumber: input.bank?.accountNumber ?? null,
      bankIfsc: input.bank?.ifsc ?? null,
      bankAccountHolderName: input.bank?.holderName ?? null,
      kycStatus: 'submitted',
      kycSubmittedAt: submittedAt,
      razorpayLinkedAccountId: linked.id,
    })
    .where(eq(tenants.id, tenantId))
    .returning();
  if (!updated) throw new Error('tenant update returned no row');

  const after = {
    kycStatus: updated.kycStatus,
    legalEntityName: updated.legalEntityName,
    panNumber: updated.panNumber,
    bankAccountNumber: updated.bankAccountNumber,
    bankIfsc: updated.bankIfsc,
    bankAccountHolderName: updated.bankAccountHolderName,
    razorpayLinkedAccountId: updated.razorpayLinkedAccountId,
  };

  await writeAudit(
    db,
    { tenantId, actorUserId },
    'kyc.submitted',
    'tenant',
    tenantId,
    before,
    after,
  );

  return {
    tenantId,
    linkedAccountId: linked.id,
    status: 'submitted',
  };
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
  if (!row) throw new NotFound('Tenant not found', 'tenant_not_found');
  return row;
}

/**
 * Called by the `kyc-status-poll` worker every 30 minutes.
 *
 * Selects tenants in a pending KYC state with a Razorpay linked-account id,
 * fetches the live status, and persists transitions with an audit row.
 *
 * Returns the count of tenants checked (not just transitioned) so the worker
 * log shows whether the poller is finding work at all.
 */
export async function pollKycStatuses(): Promise<number> {
  const rows = await db
    .select()
    .from(tenants)
    .where(
      and(
        inArray(tenants.kycStatus, ['submitted', 'in_review']),
        isNotNull(tenants.razorpayLinkedAccountId),
      ),
    );

  const adapter = getRazorpay();
  let polled = 0;

  for (const tenant of rows) {
    if (!tenant.razorpayLinkedAccountId) continue;
    polled++;

    let live: LinkedAccount;
    try {
      live = await adapter.fetchLinkedAccount(tenant.razorpayLinkedAccountId);
    } catch (err) {
      logger.error(
        { err, tenantId: tenant.id, linkedAccountId: tenant.razorpayLinkedAccountId },
        'kyc_poll_fetch_failed',
      );
      continue;
    }

    const nextStatus = mapRazorpayStatus(live.status);
    if (nextStatus === null || nextStatus === tenant.kycStatus) continue;

    const before = {
      kycStatus: tenant.kycStatus,
      kycVerifiedAt: tenant.kycVerifiedAt,
    };
    const newlyVerified = nextStatus === 'verified' && tenant.kycVerifiedAt == null;
    const set: Partial<typeof tenants.$inferInsert> = { kycStatus: nextStatus };
    if (newlyVerified) set.kycVerifiedAt = new Date();

    const [updated] = await db
      .update(tenants)
      .set(set)
      .where(eq(tenants.id, tenant.id))
      .returning();
    if (!updated) continue;

    // Poller-driven transitions have no human actor; we insert directly so
    // `actor_user_id` is NULL. The action namespace (`kyc.verified` etc.)
    // makes the system-source clear in the audit viewer.
    await db.insert(auditLog).values({
      tenantId: tenant.id,
      actorUserId: null,
      action: `kyc.${nextStatus}`,
      entityType: 'tenant',
      entityId: tenant.id,
      before,
      after: { kycStatus: updated.kycStatus, kycVerifiedAt: updated.kycVerifiedAt },
    });
  }

  if (polled > 0) {
    logger.info({ polled }, 'kyc_status_poll_done');
  } else {
    logger.debug('kyc_status_poll_idle');
  }
  return polled;
}
