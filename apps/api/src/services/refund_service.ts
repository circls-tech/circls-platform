/**
 * Refund service stub — Phase 14 owner fills these in.
 *
 * Refund engine branches by channel:
 *   - razorpay-route (Channel A) — call razorpay.refundPayment().
 *   - external / walk-in        — record a refund row but no provider call.
 *   - free                      — no-op.
 *
 * Plus `reconcilePayouts()` — daily worker that joins Razorpay settlements to
 * our `payments` rows and populates `payouts`.
 */
import { logger } from '../lib/logger.js';

export interface IssueRefundInput {
  bookingId: string;
  /** Refund amount in paise; positive. */
  amountPaise: number;
  reason: string;
  actorUserId: string;
}

export interface IssueRefundResult {
  paymentId: string;
  providerRefundId?: string;
  status: 'pending' | 'processed' | 'failed';
}

export async function issueRefund(_input: IssueRefundInput): Promise<IssueRefundResult> {
  throw new Error('refund_service.issueRefund not implemented — phase 14');
}

/** Worker handler — runs daily at 02:15 UTC. Returns count reconciled. */
export async function reconcilePayouts(): Promise<number> {
  // TODO(phase-14): Fetch yesterday's Razorpay settlements, match to our
  // payments rows by provider_payment_id, write payout rows.
  logger.debug('payout_reconciliation_stub');
  return 0;
}
