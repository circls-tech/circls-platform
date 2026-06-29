# circls-platform — repo instructions

## Keep Help Centre articles in sync with the product

The Partner Portal Help Centre ships real, user-facing documentation. **Stale help docs are a bug.**

When you add, change, or deprecate partner-facing functionality, update the matching help article(s) **in the same PR** as the code change. Do not treat docs as a follow-up.

- Article bodies: `apps/partners/content/help/*.md`
- Article metadata (titles, summaries, categories, ordering): `apps/partners/lib/help/articles.ts`
- Article → code-area map (which doc to touch for which change): `apps/partners/content/help/README.md`

Specifically re-check the relevant article when you change any of: status enum values, role capabilities, onboarding/venue/arena/schedule/booking/event/membership flows, team & invitation behaviour, API base paths (`/api/v1` aggregator, `/v1` portal), API-key roles, webhook event names or the `X-Circls-Signature` signing scheme, or image upload limits/formats.

Adding a brand-new partner feature usually means adding a new article: add an entry to `lib/help/articles.ts` and create the matching `content/help/<slug>.md`. Removing a feature means deleting both.

## Sandbox & contribution rules (read first if you are a team member)

You are a contributor with **Write** access to this repo. Your only path to ship
work is a pull request. You must NEVER:

- push to `main` or `release` (a push to `release` deploys to production),
- merge a pull request (`gh pr merge`), or
- force-push or delete `main`/`release`.

Always: create a feature **branch in this repo** → commit → push the branch →
open a PR against `main`. CI must be green and **@VedantS01 must approve** — a
GitHub ruleset enforces this. If your PR has conflicts or a failing check,
comment `@claude …` on the PR (see the PR template) instead of calling the
maintainer. (`--no-verify` is not allowed.)

Run the app with `./sandbox up` (see `SANDBOX.md`). All payments, storage, SMS,
and email are simulated locally — nothing reaches real users or money.
