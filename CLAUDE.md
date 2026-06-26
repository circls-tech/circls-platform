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

You are working in a **local sandbox**. Your only path to ship work is a pull
request from your fork. You must NEVER:

- push to `main` or `release` (a push to `release` deploys to production),
- merge a pull request (`gh pr merge`), or
- force-push or delete branches on any shared remote.

Always: create a branch → commit → push to **your fork** (`origin`) → open a PR
against the upstream repo. A maintainer reviews and merges. These rules are also
enforced by a pre-push git hook and a Claude Code guard; do not try to bypass
them (`--no-verify` is not allowed).

Run the app with `./sandbox up` (see `SANDBOX.md`). All payments, storage, SMS,
and email are simulated locally — nothing reaches real users or money.

## Sandbox seed data

Personal/demo seed data — venues, courts, arenas, slots, or any other demo
content — goes in `apps/api/src/scripts/seed_local.ts` (git-ignored), **never**
in the shared `apps/api/src/scripts/seed_sandbox.ts`. `seed_sandbox.ts` seeds
only the shared baseline (login users, tenants, memberships) and is identical for
everyone; editing it to add demo data causes merge conflicts.

`seed_local.ts` runs automatically at the end of `./sandbox seed` if it exists
(absent file is a silent no-op). If it doesn't exist, copy
`seed_local.example.ts` to `seed_local.ts` and edit its exported
`seedLocal({ db, platformTenantId, demoTenantId })` function. Keep it idempotent
(the seed can be re-run), and never `git add` `seed_local.ts`.
