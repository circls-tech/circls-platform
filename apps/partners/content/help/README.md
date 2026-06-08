# Partner Portal Help Centre — content

Partner-facing help articles, rendered by the Help Centre.

- **Article bodies:** `*.md` in this directory (GitHub-flavoured markdown).
- **Article metadata** (title, category, summary, order, quick-link flag): `apps/partners/lib/help/articles.ts`.
- **Rendering:** list at `app/(protected)/help/page.tsx`, detail at `app/(protected)/help/[slug]/page.tsx` (reads the `.md` via `lib/help/content.ts` and renders with `react-markdown` + `remark-gfm`).

Each manifest entry's `slug` MUST have a matching `<slug>.md` here, and every `.md` here MUST have a manifest entry. To add an article: add a manifest entry and create `<slug>.md`. To remove one: delete both.

## Maintenance — keep these in sync with the product

**When a feature ships, changes, or is deprecated, update the matching article(s) in the same PR.** These guides describe real product behaviour (field names, button labels, statuses, flows) — stale docs are worse than none.

Article → the code areas it documents (touch the code → check the doc):

| Article | Documents | Watch these paths |
| --- | --- | --- |
| `onboarding.md` | Onboarding wizard | `apps/partners/app/(protected)/onboarding/`, `apps/api/src/routes/tenants.ts` |
| `venues.md` | Venues, arenas, photos, listing statuses | `apps/partners/app/(protected)/venues/`, `app/(protected)/arenas/`, `apps/partners/components/VenueImages.tsx`, `apps/api/src/routes/venues.ts`, `arenas.ts`, `venue_images.ts`, `apps/api/src/db/schema/venues.ts`, `arenas.ts` |
| `schedule.md` | Schedule builder, slot release, reception view | `apps/partners/app/(protected)/arenas/[arenaId]/schedule/`, `apps/partners/components/Matrix.tsx`, `apps/api/src/routes/slots.ts`, `apps/api/src/db/schema/slots.ts`, `schedules.ts` |
| `bookings.md` | Bookings, cancellations, refunds, no-shows, CSV | `apps/partners/app/(protected)/venues/[venueId]/bookings/`, `app/(protected)/bookings/[id]/cancel/`, `apps/api/src/routes/bookings.ts`, `cancellations.ts`, `apps/api/src/db/schema/bookings.ts` |
| `events.md` | Event create/edit/submit/publish, images, registrations | `apps/partners/app/(protected)/events/`, `app/(protected)/venues/[venueId]/events/`, `apps/api/src/routes/events.ts`, `apps/api/src/db/schema/events.ts` |
| `memberships.md` | Membership plans, activate/deactivate, buyers | `apps/partners/app/(protected)/memberships/`, `apps/api/src/routes/memberships.ts`, `apps/api/src/db/schema/memberships.ts` |
| `coupons.md` | Coupon create/edit/pause/delete, scope, discount type, visibility, limits | `apps/partners/app/(protected)/coupons/`, `apps/partners/lib/api/coupons.ts`, `apps/api/src/routes/coupons.ts`, `apps/api/src/routes/checkout.ts`, `apps/api/src/db/schema/coupons.ts` |
| `team.md` | Roles, invitations, role changes, removal | `apps/partners/app/(protected)/settings/team/`, `app/(auth)/invite/`, `apps/api/src/routes/invitations.ts`, `apps/api/src/lib/authz/role_caps.ts`, `apps/api/src/db/schema/tenant_members.ts` |
| `api-keys.md` | API keys, aggregator API, webhooks & signing | `apps/partners/app/(protected)/settings/api-keys/`, `settings/webhooks/`, `apps/api/src/routes/api_keys.ts`, `webhook_subscriptions.ts`, `apps/api/src/lib/webhooks/sign.ts`, `apps/api/src/db/schema/api_keys.ts`, `webhooks.ts` |

Facts especially worth re-checking when the code moves: status enum values, role capabilities, API base paths (`/api/v1` for aggregators, `/v1` for the portal), webhook event names, the `X-Circls-Signature` scheme, and upload limits/formats.
