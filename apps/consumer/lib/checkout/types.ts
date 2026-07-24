import type { CurrencyCode } from '@/lib/format';

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
      /** Entry code the viewer unlocked an invite-only event with. */
      accessCode?: string;
    })
  | (CheckoutItemBase & { kind: 'membership'; membershipId: string; membershipTierId?: string });

export interface CheckoutPrefill {
  name?: string;
  contact?: string;
}
