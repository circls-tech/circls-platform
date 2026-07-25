import type { CurrencyCode } from '@/lib/format';
import type { PublicEventQuestion } from '@/lib/api/types';

export type CheckoutLine = { tierId: string; tierName: string; quantity: number; unitPricePaise: number };

/** Fields shared by every checkout item. `currency` only affects how the
 *  price breakdown is DISPLAYED (defaults to INR); the payment order itself
 *  comes from the API. */
interface CheckoutItemBase {
  title: string;
  currency?: CurrencyCode;
}

export type CheckoutItem =
  | (CheckoutItemBase & { kind: 'slot'; slotIds: string[] })
  | (CheckoutItemBase & {
      kind: 'event';
      eventId: string;
      lines: CheckoutLine[];
      /** The event's registration questions — when present, the modal collects
       *  answers before payment. */
      questions?: PublicEventQuestion[];
    })
  | (CheckoutItemBase & { kind: 'membership'; membershipId: string; membershipTierId?: string });

export interface CheckoutPrefill {
  name?: string;
  contact?: string;
  /** A coupon code to arrive with already applied (e.g. tapped on the event
   *  page's offers strip). Invalid codes surface the usual coupon error. */
  couponCode?: string;
}
