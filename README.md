# circls-platform

Circls platform monorepo. Fastify backend + Next.js portals (admin, partners). The Flutter consumer app lives separately at [`VedantS01/circls-flutter`](https://github.com/VedantS01/circls-flutter).

## Status

Phase 0 (repo foundation) complete as of 2026-05-19. Implementation begins with Phase 1 (backend skeleton) in the next session. The phased plan is in [`IMPLEMENTATION_GUIDE.md`](./IMPLEMENTATION_GUIDE.md) — read it before opening a new session.

## What this is, in one paragraph

A two-app Next.js + one-service Fastify monorepo. The Fastify service in `apps/api` owns all data, business rules, integrations (Razorpay, notifications, object storage), and background workers. The Next.js apps in `apps/admin` and `apps/partners` are thin frontends that call its typed API. Shared TypeScript types live in `packages/api-types`; shared React components in `packages/ui-kit`; shared toolchain configs in `packages/config`. The Flutter consumer app at `circls.app` consumes the same backend via an OpenAPI-generated Dart client.

## Repo layout

```
circls-platform/
├── apps/
│   ├── api/                  Fastify backend + worker (single codebase, two entry points)
│   ├── admin/                Next.js — admin.circls.app
│   └── partners/             Next.js — partners.circls.app
├── packages/
│   ├── api-types/            Shared TypeScript types for the API contract
│   ├── ui-kit/               Shared React components (Tailwind)
│   └── config/               Shared eslint, prettier, tsconfig
├── docs/
│   ├── VISION.md             What we're building and why
│   └── ARCHITECTURE.md       System design + locked tech-stack + schema decisions
├── IMPLEMENTATION_GUIDE.md   Phased plan for sessions
├── pnpm-workspace.yaml
├── package.json
├── .nvmrc                    Node 24
└── .gitignore
```

The `apps/` and `packages/` directories are intentionally empty at Phase 0. Each child is scaffolded in its own phase per [`IMPLEMENTATION_GUIDE.md`](./IMPLEMENTATION_GUIDE.md).

## Required reading before contributing

1. [`docs/VISION.md`](./docs/VISION.md) — what Circls is, the four channels, the money flow.
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the five-layer Core, locked tech stack, locked schema decisions.
3. [`IMPLEMENTATION_GUIDE.md`](./IMPLEMENTATION_GUIDE.md) — the phased build plan.

## Quick start (once apps exist)

```bash
nvm use                       # Node 24
pnpm install
pnpm dev                      # Currently a stub — wired up in Phase 1
```

## Tenant listing auto-approval

On the admin portal's tenant detail page, **Listing approval** has a checkbox per
aspect a tenant may take live without admin review:

- **Venues and arenas** — a submitted venue or arena activates at once.
- **Events** — a submitted complete event publishes at once, single dates and
  whole recurring series alike.
- **Memberships** — a submitted complete membership plan goes on sale at once.
- **Changes to live listings** — event change requests are validated and applied
  immediately (their approved history is retained), and a live arena's details
  can be edited in place.

Every aspect defaults to off and can only be changed by platform admins with
tenant-management permission (`PATCH /v1/admin/tenants/:id/listing-approval`,
one key per aspect to change); each change is recorded in the tenant audit log
with every aspect before and after.

Drafts remain drafts until submitted. Existing rules still apply, including
completeness checks, membership deactivation before editing and protections for
sold tickets. Automatic approvals send neither review-queue emails nor
approval-outcome emails. Existing pending reviews are unchanged, and unticking an
aspect restores review for future submissions of that kind; already-live listings
stay live.

The settings live in `tenants.auto_approve` (jsonb, a missing key means off).
Migration `0082_tenant_auto_approve_aspects` replaces the earlier single switch,
turning every aspect on for tenants that had it enabled. Apply it before
deploying the updated API.

## License

MIT - see [LICENSE](./LICENSE).
