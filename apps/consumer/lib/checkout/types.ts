export type CheckoutItem =
  | { kind: 'slot'; slotIds: string[]; title: string }
  | { kind: 'event'; eventId: string; title: string }
  | { kind: 'membership'; membershipId: string; title: string };

export interface CheckoutPrefill {
  name?: string;
  contact?: string;
}
