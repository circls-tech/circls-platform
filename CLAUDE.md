# circls-platform — repo instructions

## Keep Help Centre articles in sync with the product

The Partner Portal Help Centre ships real, user-facing documentation. **Stale help docs are a bug.**

When you add, change, or deprecate partner-facing functionality, update the matching help article(s) **in the same PR** as the code change. Do not treat docs as a follow-up.

- Article bodies: `apps/partners/content/help/*.md`
- Article metadata (titles, summaries, categories, ordering): `apps/partners/lib/help/articles.ts`
- Article → code-area map (which doc to touch for which change): `apps/partners/content/help/README.md`

Specifically re-check the relevant article when you change any of: status enum values, role capabilities, onboarding/venue/arena/schedule/booking/event/membership flows, team & invitation behaviour, API base paths (`/api/v1` aggregator, `/v1` portal), API-key roles, webhook event names or the `X-Circls-Signature` signing scheme, or image upload limits/formats.

Adding a brand-new partner feature usually means adding a new article: add an entry to `lib/help/articles.ts` and create the matching `content/help/<slug>.md`. Removing a feature means deleting both.
