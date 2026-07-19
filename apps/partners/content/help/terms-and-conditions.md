Every organisation on circls operates under the **Partner Terms & Conditions** — the agreement between your organisation and circls that covers listings, bookings, payments, payouts and data protection. There are two regional documents: one for organisations based in **India** and one for organisations based in the **United States**. You can read both at any time on the [Terms & Conditions page](/terms).

## When you accept

**New organisations** accept during onboarding: step 1 of the wizard asks where your organisation is based, shows the Terms for that region, and requires an authorisation checkbox before the organisation can be created. The acceptance — version, region, time and the accepting user — is recorded against the organisation.

**Existing organisations** that have not yet accepted (or whenever the Terms are updated to a new version) see a full-page **Terms & Conditions** screen when they open the Partner Portal. Until an owner or manager accepts:

- the rest of the portal is blocked (the Help Centre stays available), and
- the API refuses to create new **venues**, **events** or **membership plans** for the organisation (error code `terms_required`).

Existing venues, bookings, events and memberships keep working — the gate only blocks *creating new listings* and portal access, never money you're owed or bookings your customers already hold.

## Who can accept

Accepting binds the organisation, so only members with the **owner** or **manager** role can accept. If you sign in with a staff or read-only role while your organisation is gated, ask an owner or manager to sign in and accept.

## Which document applies

The region is taken from where your organisation is based:

| Based in | Document | Currency & gateway |
| --- | --- | --- |
| India (or anywhere outside the US) | India Terms | ₹ INR via Razorpay |
| United States | US Terms | $ USD via Stripe |

If your organisation predates the Terms feature and has no country on file yet, the acceptance screen asks for it and saves it to your organisation profile.

## Version updates

When circls publishes a new version of the Terms, every organisation is asked to accept it again before creating new listings. The currently accepted version is stored on your organisation, and each acceptance is recorded with its version and timestamp.
