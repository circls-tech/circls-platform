import { CURRENT_TERMS_VERSION, type TermsRegion } from './constants';

/**
 * The Partner Terms & Conditions documents, one per region. Markdown, rendered
 * with the same ReactMarkdown pipeline as the Help Centre. The version header
 * inside each document must match CURRENT_TERMS_VERSION — the org accepts the
 * revision it is shown.
 */

const COMMON_INTRO = `**Version ${CURRENT_TERMS_VERSION} — effective 19 July 2026**

These Partner Terms & Conditions (the "Terms") are an agreement between the
organisation identified at registration (the "Partner", "you") and Circls (the
"Platform", "we"). By accepting, the individual acting for the Partner confirms
they are authorised to bind the Partner to these Terms. They govern the
Partner's use of the Circls Partner Portal and the listing of venues, arenas,
bookable slots, events and membership plans to consumers through Circls.`;

export const TERMS_IN_MD = `# Circls Partner Terms & Conditions (India)

${COMMON_INTRO}

## 1. Definitions

- **"Portal"** — the Circls Partner Portal and the partner API.
- **"Listings"** — venues, arenas, slot schedules, events (including recurring
  event series and ticket tiers), membership plans and coupons the Partner
  publishes through the Portal.
- **"Customer"** — a consumer who books, registers or purchases a Listing
  through Circls.
- **"Partner Agreement"** — any separate commercial agreement between the
  Partner and Circls setting the Partner's commission rate and payout terms.

## 2. Eligibility and account

The Partner must be validly constituted under the laws of India and hold every
registration, permit and licence required to operate its facilities and run its
activities. Information provided at registration and in Listings must be
accurate and kept current. The Partner is responsible for all activity under
its organisation account, including team members it invites and API keys it
issues, and must keep credentials confidential.

## 3. The service

Circls provides a technology platform through which the Partner publishes
Listings and Customers discover, book and pay for them. Circls is not the
provider of the sporting or venue services: the contract for the underlying
service is between the Partner and the Customer. Circls may moderate, suspend
or remove Listings that are unlawful, unsafe, misleading or in breach of these
Terms.

## 4. Partner obligations

The Partner shall: (a) describe Listings accurately, including pricing,
capacity, timings and any restrictions; (b) honour every confirmed booking,
event registration and membership at the listed price; (c) maintain its
facilities in a safe, lawful condition and carry appropriate insurance;
(d) comply with applicable law, including safety, employment and consumer
protection law; and (e) not use the Portal to send unlawful or misleading
communications or to collect Customer data beyond what is needed to deliver
the booked service.

## 5. Payments and payouts

Circls is the merchant of record for Customer payments. Payments are collected
in Indian Rupees (INR) through Circls's payment partner (currently Razorpay).
Circls pays out to the Partner on a weekly cycle: gross collections, net of
refunds and of the platform commission set out in the Partner Agreement.
Payout timing may be adjusted for holidays, risk review or gateway settlement
delays. The Partner must provide accurate payout account details; Circls is
not liable for delays caused by incorrect details.

## 6. Cancellations and refunds

Cancellation windows and refund treatment follow the policies displayed to the
Customer at the time of booking. Refunds Circls issues to Customers under those
policies (or under applicable law) are deducted from subsequent payouts. The
Partner must promptly notify Circls of closures or cancellations affecting
confirmed bookings.

## 7. Taxes

The Partner is responsible for its own tax obligations, including GST
registration, invoicing and remittance on the services it supplies. Circls may
collect or withhold tax where required by law (including TCS/TDS obligations
under GST and income-tax law) and will report as legally required.

## 8. Content and intellectual property

The Partner grants Circls a non-exclusive, royalty-free, worldwide licence to
host, display and promote its Listing content (names, logos, descriptions,
photographs) on the Platform and in Circls marketing of the Platform. The
Partner warrants it holds the rights to the content it uploads. Circls and its
marks remain Circls's property.

## 9. Data protection

Each party shall comply with applicable Indian data-protection law, including
the Digital Personal Data Protection Act, 2023 and the Information Technology
Act, 2000. Customer personal data shared with the Partner may be used only to
deliver the booked service and must be protected with reasonable safeguards.

## 10. Suspension and termination

Circls may suspend or terminate the Partner's access for material breach,
unlawful activity, risk to Customers, or failure to accept an updated version
of these Terms. The Partner may stop using the Portal at any time; confirmed
bookings must still be honoured or refunded. Accrued payout obligations, and
clauses which by nature survive, survive termination.

## 11. Disclaimers and liability

The Portal is provided "as is". To the maximum extent permitted by law, Circls
excludes implied warranties and is not liable for indirect or consequential
loss, loss of profit or loss of data. Circls's aggregate liability to the
Partner in any 12-month period is limited to the commission Circls retained
from the Partner's transactions in that period. Nothing limits liability that
cannot be limited under law.

## 12. Indemnity

The Partner shall indemnify Circls against claims, losses and costs arising
from the Partner's Listings, facilities or services, its breach of these Terms,
or its violation of law or third-party rights.

## 13. Changes to these Terms

Circls may update these Terms by publishing a new version in the Portal. The
Partner will be asked to accept the new version before creating new Listings;
continued acceptance is recorded against the organisation with the version,
time and accepting user.

## 14. Governing law and disputes

These Terms are governed by the laws of India. Disputes shall first be
attempted to be resolved amicably; failing that, they shall be referred to
arbitration by a sole arbitrator seated in Bengaluru, Karnataka under the
Arbitration and Conciliation Act, 1996, conducted in English. Subject to that,
the courts at Bengaluru have exclusive jurisdiction.

## 15. Contact

Questions about these Terms: support@circls.app.
`;

export const TERMS_US_MD = `# Circls Partner Terms & Conditions (United States)

${COMMON_INTRO}

## 1. Definitions

- **"Portal"** — the Circls Partner Portal and the partner API.
- **"Listings"** — venues, arenas, slot schedules, events (including recurring
  event series and ticket tiers), membership plans and coupons the Partner
  publishes through the Portal.
- **"Customer"** — a consumer who books, registers or purchases a Listing
  through Circls.
- **"Partner Agreement"** — any separate commercial agreement between the
  Partner and Circls setting the Partner's commission rate and payout terms.

## 2. Eligibility and account

The Partner must be a business entity validly existing under the laws of its
state of formation and hold every permit and license required to operate its
facilities and run its activities. Information provided at registration and in
Listings must be accurate and kept current. The Partner is responsible for all
activity under its organisation account, including team members it invites and
API keys it issues, and must keep credentials confidential.

## 3. The service

Circls provides a technology platform through which the Partner publishes
Listings and Customers discover, book and pay for them. Circls is not the
provider of the sporting or venue services: the contract for the underlying
service is between the Partner and the Customer. Circls may moderate, suspend
or remove Listings that are unlawful, unsafe, misleading or in breach of these
Terms.

## 4. Partner obligations

The Partner shall: (a) describe Listings accurately, including pricing,
capacity, timings and any restrictions; (b) honor every confirmed booking,
event registration and membership at the listed price; (c) maintain its
facilities in a safe, lawful condition and carry appropriate insurance,
including commercial general liability coverage; (d) comply with applicable
federal, state and local law, including the Americans with Disabilities Act
and consumer-protection law; and (e) not use the Portal to send unlawful or
misleading communications or to collect Customer data beyond what is needed to
deliver the booked service.

## 5. Payments and payouts

Circls is the merchant of record for Customer payments. Payments are collected
in US Dollars (USD) through Circls's payment partner (currently Stripe).
Circls pays out to the Partner on a weekly cycle: gross collections, net of
refunds and of the platform commission set out in the Partner Agreement.
Payout timing may be adjusted for holidays, risk review or gateway settlement
delays. The Partner must provide accurate payout account details; Circls is
not liable for delays caused by incorrect details.

## 6. Cancellations and refunds

Cancellation windows and refund treatment follow the policies displayed to the
Customer at the time of booking. Refunds Circls issues to Customers under those
policies (or under applicable law) are deducted from subsequent payouts. The
Partner must promptly notify Circls of closures or cancellations affecting
confirmed bookings.

## 7. Taxes

The Partner is responsible for its own tax obligations, including determining,
collecting and remitting any applicable sales, use or similar taxes on the
services it supplies, except where marketplace-facilitator law requires Circls
to collect. Circls will file information returns (such as Form 1099-K) where
required and may request a Form W-9 as a condition of payout.

## 8. Content and intellectual property

The Partner grants Circls a non-exclusive, royalty-free, worldwide license to
host, display and promote its Listing content (names, logos, descriptions,
photographs) on the Platform and in Circls marketing of the Platform. The
Partner warrants it holds the rights to the content it uploads. Circls and its
marks remain Circls's property.

## 9. Data protection

Each party shall comply with applicable US privacy law, including state
consumer-privacy statutes where they apply. Customer personal data shared with
the Partner may be used only to deliver the booked service and must be
protected with reasonable safeguards.

## 10. Suspension and termination

Circls may suspend or terminate the Partner's access for material breach,
unlawful activity, risk to Customers, or failure to accept an updated version
of these Terms. The Partner may stop using the Portal at any time; confirmed
bookings must still be honored or refunded. Accrued payout obligations, and
clauses which by nature survive, survive termination.

## 11. Disclaimers and liability

THE PORTAL IS PROVIDED "AS IS" AND "AS AVAILABLE". TO THE MAXIMUM EXTENT
PERMITTED BY LAW, CIRCLS DISCLAIMS ALL IMPLIED WARRANTIES, INCLUDING
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT, AND IS
NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL OR CONSEQUENTIAL DAMAGES, LOSS OF
PROFIT OR LOSS OF DATA. CIRCLS'S AGGREGATE LIABILITY TO THE PARTNER IN ANY
12-MONTH PERIOD IS LIMITED TO THE COMMISSION CIRCLS RETAINED FROM THE
PARTNER'S TRANSACTIONS IN THAT PERIOD.

## 12. Indemnity

The Partner shall indemnify, defend and hold harmless Circls against claims,
losses and costs arising from the Partner's Listings, facilities or services,
its breach of these Terms, or its violation of law or third-party rights.

## 13. Changes to these Terms

Circls may update these Terms by publishing a new version in the Portal. The
Partner will be asked to accept the new version before creating new Listings;
continued acceptance is recorded against the organisation with the version,
time and accepting user.

## 14. Governing law and disputes

These Terms are governed by the laws of the State of Delaware, excluding its
conflict-of-laws rules. Any dispute shall be resolved by binding arbitration
administered by the American Arbitration Association under its Commercial
Arbitration Rules, seated in Wilmington, Delaware, on an individual basis —
each party waives any right to participate in a class action. Either party may
seek injunctive relief in court for intellectual-property or confidentiality
breaches.

## 15. Contact

Questions about these Terms: support@circls.app.
`;

export function termsMarkdownForRegion(region: TermsRegion): string {
  return region === 'US' ? TERMS_US_MD : TERMS_IN_MD;
}
