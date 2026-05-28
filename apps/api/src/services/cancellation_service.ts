/**
 * Cancellation service stub — Phase 14 owner fills these in. Note this is
 * separate from booking_service.cancelBooking() which handles the walk-in case
 * (no payment to reverse). This one handles paid bookings, refund window
 * decisions, no-show flags, etc.
 *
 * Contract surfaces:
 *   - cancelPaidBooking(): public route handler. Looks up policy, decides
 *     refundable / partial / no-refund, calls refund_service.issueRefund().
 */
export interface CancelInput {
  bookingId: string;
  actorUserId: string;
  reason: string;
  /** True when the actor is the customer themselves (vs. venue staff / admin). */
  bySelf: boolean;
}

export interface CancelResult {
  bookingId: string;
  status: 'cancelled';
  refundPaise: number;
  refundId?: string;
}

export async function cancelPaidBooking(_input: CancelInput): Promise<CancelResult> {
  throw new Error('cancellation_service.cancelPaidBooking not implemented — phase 14');
}
