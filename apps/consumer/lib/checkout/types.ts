export type CheckoutLine = { tierId: string; tierName: string; quantity: number; unitPricePaise: number };

export type CheckoutItem =
  | { kind: 'slot'; slotIds: string[]; title: string }
  | { kind: 'event'; eventId: string; title: string; lines: CheckoutLine[] }
  | { kind: 'membership'; membershipId: string; title: string };

export interface CheckoutPrefill {
  name?: string;
  contact?: string;
}
