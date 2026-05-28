# Team management — design

> **Status:** Approved 2026-05-28 (brainstorm). Pending plan.
> **Sub-project:** D of the MVP retarget (after Track B integration on 2026-05-28). Other sub-projects: A — KYC strip + Circls-as-merchant payouts. B — Listing approval workflow. C — Phase 15 cleanup (events as venue-scoped) + partner UI. E — Consumer portal (`circls.app`).

## Context

Track B (Phases 11–17) shipped 2026-05-28 as a parallel-subagent fan-out. The MVP scope then sharpened:

1. **Circls is the merchant.** No per-tenant Razorpay Linked Account or KYC. Payments land in Circls's account; payouts to venues are manual, on a schedule, executed by Circls ops via the admin portal. (Sub-project A.)
2. **Consumer portal (`circls.app`)** is in-scope for MVP — was deferred Phase 18, now critical-path. (Sub-project E.)
3. **Events + memberships are venue-level**, not arena-level. Phase 15's `event_arenas` join table is wrong. (Sub-project C.)
4. **Admin portal needs payouts, listing approval, and Circls-as-tenant.** (Sub-project A + B.)
5. **Team management** — this design.

Team management blocks A, B, C, and the admin portal: every privileged endpoint needs an authorization model, every "Circls ops member" decision needs a defined source of truth, and the partner portal needs invitation UX before real customers can onboard.

## Goals

- Per-tenant team membership with **enforced role-based authorization** (today's membership table allows-all-members).
- **Email-based invitation flow** to onboard team members — partner portal moves from phone-OTP to email/password.
- **Circls as a tenant** with `is_platform=true` — admin portal access is membership in that tenant, not an env-var allowlist (retires Phase 16's `PLATFORM_ADMIN_USER_IDS`).
- **Audit every membership-touching mutation** through the existing `audit_log` table.

## Non-goals (deferred)

- Per-venue scoping of staff within a multi-venue tenant. Whole-org access is sufficient for MVP. (Future migration is non-breaking — add an optional venue-scope filter on top of existing membership.)
- Per-member capability overrides (Approach B from brainstorm). `tenant_members.permissions_override jsonb` remains in the schema unused, as a future hook.
- Custom role authoring (Approach C). The four-role enum is fixed.
- Consumer portal authentication model — that's part of sub-project E.
- Email verification on signup. The invite-link itself proves email control for partners; no self-signup exists.
- Multi-tenant ownership transfer UI as a single endpoint. The model supports it via two API calls (promote a manager to owner, then self-demote).

## Architecture overview

```
partners.circls.app                 admin.circls.app
    | (email/password)                   | (email/password)
    v                                    v
Firebase Auth (project: circls-418b6)
    |                                    |
    +------------- ID token --------------+
                        |
                        v
                  apps/api  ── verifyIdToken → users
                        |
                        v
              requireTenantMembership  (returns {tenantId, userId, role, isPlatform})
                        |
                        v
              requireCap(ctx, 'venues.write')
                        |
                        v
        partner-tenant capabilities   |   platform-tenant capabilities
                                (chosen by ctx.tenant.isPlatform)
```

Both portals use Firebase Auth's email/password provider. The API verifies the ID token and resolves the active tenant via `tenant_members`. Every privileged endpoint declares the **capability** it needs via `requireCap(ctx, cap)`. Capabilities are computed from `(role, isPlatform)` via two compile-time maps.

## §1 — Data model

### 1.1 `tenants` (modify)

Add one column:

```sql
ALTER TABLE tenants ADD COLUMN is_platform boolean NOT NULL DEFAULT false;
```

Set `true` *only* on the Circls-internal row. Belt-and-suspenders next to the reserved slug — the boolean is what authz queries actually read; the slug exists for human ops.

### 1.2 `tenant_members` (no change)

Schema stays. Roles `owner / manager / staff / readonly`. `permissions_override jsonb` remains for future Approach-B migration; authz layer ignores it.

### 1.3 `tenant_invitations` (new)

```sql
CREATE TABLE tenant_invitations (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email                text NOT NULL,                  -- lowercased on insert
  role                 tenant_role NOT NULL,
  invited_by_user_id   uuid NOT NULL REFERENCES users(id),
  token_prefix         text NOT NULL,                  -- first 12 chars (indexed lookup)
  token_hash           text NOT NULL,                  -- bcrypt(full_token, 10)
  expires_at           timestamptz NOT NULL,           -- default now() + 7d
  accepted_at          timestamptz,
  accepted_user_id     uuid REFERENCES users(id),
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_invitations_token_prefix_idx
  ON tenant_invitations (token_prefix);

CREATE INDEX tenant_invitations_tenant_email_idx
  ON tenant_invitations (tenant_id, email);

-- Block duplicate live invitations for the same email on the same tenant.
-- NOTE: the predicate must be IMMUTABLE (Postgres rejects now() in partial
-- index predicates because it's STABLE). So we treat any non-accepted /
-- non-revoked row as live; the resend path UPDATEs the existing row in place
-- (bumps expires_at + rotates token), and the API-layer "already a member?"
-- check rejects re-invites after acceptance.
CREATE UNIQUE INDEX tenant_invitations_live_uniq
  ON tenant_invitations (tenant_id, email)
  WHERE accepted_at IS NULL
    AND revoked_at IS NULL;
```

### 1.4 `users` (no change)

`email text UNIQUE` already exists. `phone_e164` stays nullable (consumer portal keeps phone-OTP — sub-project E).

## §2 — Authorization model

### 2.1 Capability enum

A flat list, exported from `apps/api/src/lib/authz/capabilities.ts`:

```ts
export type Capability =
  // tenant
  | 'tenant.read' | 'tenant.update' | 'tenant.delete'
  // members
  | 'members.read' | 'members.invite' | 'members.role_change' | 'members.remove'
  // partner ops
  | 'venues.read' | 'venues.write'
  | 'arenas.read' | 'arenas.write'
  | 'schedules.read' | 'schedules.write'
  | 'pricing.read' | 'pricing.write'
  | 'bookings.read' | 'bookings.create' | 'bookings.cancel'
  | 'analytics.read' | 'financials.read'
  | 'events.read' | 'events.write'
  | 'memberships.read' | 'memberships.write'
  // platform-only (granted only when ctx.tenant.isPlatform === true)
  | 'admin.tenants.read' | 'admin.tenants.suspend'
  | 'admin.listings.review' | 'admin.payouts.execute'
  | 'admin.audit.read';
```

### 2.2 Role → capability tables

Two maps, source-of-truth, kept in `apps/api/src/lib/authz/role_caps.ts`:

```ts
export const PARTNER_CAPS: Record<TenantRole, Capability[]> = {
  owner: [
    'tenant.read', 'tenant.update', 'tenant.delete',
    'members.read', 'members.invite', 'members.role_change', 'members.remove',
    'venues.read', 'venues.write',
    'arenas.read', 'arenas.write',
    'schedules.read', 'schedules.write',
    'pricing.read', 'pricing.write',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read', 'financials.read',
    'events.read', 'events.write',
    'memberships.read', 'memberships.write',
  ],
  manager: [
    'tenant.read', 'tenant.update',
    'members.read', 'members.invite', 'members.role_change', 'members.remove',
    'venues.read', 'venues.write',
    'arenas.read', 'arenas.write',
    'schedules.read', 'schedules.write',
    'pricing.read', 'pricing.write',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read', 'financials.read',
    'events.read', 'events.write',
    'memberships.read', 'memberships.write',
  ],
  staff: [
    'tenant.read',
    'members.read',
    'venues.read', 'arenas.read', 'schedules.read', 'pricing.read',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read',
    'events.read', 'memberships.read',
  ],
  readonly: [
    'tenant.read',
    'members.read',
    'venues.read', 'arenas.read', 'schedules.read', 'pricing.read',
    'bookings.read',
    'analytics.read', 'financials.read',
    'events.read', 'memberships.read',
  ],
};

export const PLATFORM_CAPS: Record<TenantRole, Capability[]> = {
  // Circls founder/CTO: everything platform + everything partner-of-Circls.
  owner: [
    ...PARTNER_CAPS.owner,
    'admin.tenants.read', 'admin.tenants.suspend',
    'admin.listings.review', 'admin.payouts.execute',
    'admin.audit.read',
  ],
  // Ops lead: all platform admin powers; no team mgmt of Circls itself.
  manager: [
    'tenant.read', 'tenant.update',
    'members.read',
    'admin.tenants.read', 'admin.tenants.suspend',
    'admin.listings.review', 'admin.payouts.execute',
    'admin.audit.read',
  ],
  // Ops IC: tenant + listing review + audit, no payout execution, no suspend.
  staff: [
    'tenant.read',
    'members.read',
    'admin.tenants.read',
    'admin.listings.review',
    'admin.audit.read',
  ],
  // Read-only audit / accountant for Circls.
  readonly: [
    'tenant.read',
    'members.read',
    'admin.tenants.read',
    'admin.audit.read',
  ],
};
```

### 2.3 `can()` helper

```ts
export function can(ctx: TenantContext, cap: Capability): boolean {
  const map = ctx.isPlatform ? PLATFORM_CAPS : PARTNER_CAPS;
  return map[ctx.role].includes(cap);
}
```

### 2.4 Middleware

`apps/api/src/middleware/tenant_context.ts`:
- `requireTenantMembership(userId, tenantId)` now returns `{tenantId, userId, role, isPlatform}` (carries `tenants.is_platform`).

`apps/api/src/middleware/require_cap.ts` (new):
- `requireCap(cap: Capability): preHandler` — resolves the tenant from the route param `:tenantId`, calls `requireTenantMembership`, then `can()` — throws `Forbidden('forbidden_capability', 'forbidden_capability', { cap })` on miss.

Existing `require_admin` (Track A) is replaced by `requireCap('members.invite')` (or the appropriate cap) at every call site. Existing `require_platform_admin` (Phase 16) is replaced by `requireCap('admin.tenants.read')` at every call site.

### 2.5 Owner safety invariants

Enforced at the API/service layer in `apps/api/src/services/team_service.ts`, not at the capability layer:

- Cannot demote the last `owner` to a lesser role (`PATCH /members/:userId`).
- Cannot remove the last `owner` (`DELETE /members/:userId`).
- Owner transfer is two calls: (1) promote a manager to owner; (2) the now-redundant owner demotes themselves. Single-call transfer is non-goal for MVP.
- Both invariants raise `Conflict('last_owner_protected', 'last_owner_protected')`.

## §3 — Invitation flow

### 3.1 Send

`POST /v1/tenants/:id/invitations` body `{ email, role }`

1. `requireCap('members.invite')`.
2. Lowercase email, validate format + role enum.
3. 409 if a live invitation row already exists for `(tenant_id, lower(email))` (the partial unique index catches the race).
4. 409 if a user with this email is already an active member of this tenant.
5. Generate token: 24 random bytes → `crypto.randomBytes(24).toString('base64url')` → 32 chars.
6. INSERT `tenant_invitations` with `token_hash = bcrypt(token, 10)`, `token_prefix = token.slice(0, 12)`, `expires_at = now() + 7 days`.
7. Enqueue an email via Phase 13 dispatcher: template `tenant.invitation`, payload `{ tenantName, inviterName, role, inviteUrl }` where `inviteUrl = ${PARTNERS_BASE_URL}/invite/${token}`.
8. `writeAudit(ctx, 'tenant.invitation_sent', 'invitation', invitation.id, null, { email, role, expiresAt })`.
9. Return the invitation row stripped of token fields.

### 3.2 Lookup (unauthenticated)

`GET /v1/invitations/lookup?token=<token>`

1. Compute `prefix = token.slice(0, 12)`.
2. `SELECT * FROM tenant_invitations WHERE token_prefix = $prefix AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`.
3. bcrypt-compare each candidate's `token_hash` to `token`. Return the first match or 404.
4. Return `{ tenantName, inviterName, role, email }` for the accept page UI.

### 3.3 Accept (unauthenticated)

`POST /v1/invitations/:token/accept` body `{ firebaseIdToken }`

1. Verify Firebase ID token. Extract `firebaseUid` + claimed `email`.
2. Look up invitation by token (same as 3.2). Reject if missing / revoked / expired / accepted.
3. Reject `403 invitation_email_mismatch` if invitation email ≠ token email (case-insensitive).
4. In a transaction:
   - Find-or-create the `users` row (`firebase_uid`, `email`).
   - `INSERT tenant_members(user_id, tenant_id, role)` — `ON CONFLICT DO NOTHING` to absorb a duplicate accept race.
   - `UPDATE tenant_invitations SET accepted_at = now(), accepted_user_id = $user.id WHERE id = $inv.id AND accepted_at IS NULL` — RETURNING; if no row, accept already happened, return 409 `already_accepted`.
   - Two audit rows: `tenant.invitation_accepted` (actor = the accepting user) and `tenant.member_added` (actor = the accepting user, source='invitation').
5. Return the new tenant context payload (same shape as `/v1/me`).

### 3.4 Other endpoints

| Method | Path | Cap | Notes |
|---|---|---|---|
| `GET` | `/v1/tenants/:id/invitations` | `members.read` | `?status=pending\|accepted\|expired\|revoked`, paged |
| `POST` | `/v1/tenants/:id/invitations/:invId/resend` | `members.invite` | rotates `token_hash` + `token_prefix` + `expires_at`; old token dead |
| `DELETE` | `/v1/tenants/:id/invitations/:invId` | `members.invite` | sets `revoked_at`; idempotent |
| `GET` | `/v1/tenants/:id/members` | `members.read` | list with role + joined user info |
| `PATCH` | `/v1/tenants/:id/members/:userId` | `members.role_change` | change role; enforces last-owner invariant |
| `DELETE` | `/v1/tenants/:id/members/:userId` | `members.remove` *(or self)* | remove; enforces last-owner; **self-remove (actor === target) bypasses the `members.remove` cap so staff/readonly can leave the org** |

### 3.5 Edge cases

| Scenario | Handling |
|---|---|
| Email already has a Firebase Auth user (member of another tenant) | Frontend detects Firebase's `auth/email-already-in-use` error, switches to sign-in form; user signs in with their existing password; same accept endpoint. |
| Wrong person clicks the link (Firebase email ≠ invitation email) | Accept returns 403 `invitation_email_mismatch`. UI: "this invitation was sent to a different address." No "change email" option. |
| Resend after a still-valid invite | Rotates the token (UPDATE `token_hash`, `token_prefix`, `expires_at`). Old token now bcrypt-mismatches. Sends new email. |
| Resend after expiry | Same as resend — `expires_at` is bumped. |
| Re-invite after acceptance | The original row is `accepted_at NOT NULL`, so the partial unique index permits a new live row. But the API-layer check ("already a member?") rejects the new invite with 409 `already_member`. |
| Concurrent accepts (race) | The conditional UPDATE in step 4 returns no row for the loser → 409 `already_accepted`. The conditional INSERT into `tenant_members` is `ON CONFLICT DO NOTHING` so it's idempotent. |
| Founder-tenant bootstrap | `POST /v1/tenants` creates the founding `tenant_members` row inline (existing behavior). No invitation involved. |

## §4 — Auth migration (partners portal)

### 4.1 Frontend

- `apps/partners/lib/firebase/auth_context.tsx` — replace `sendOtp` with `signInWithEmail(email, password)` + `sendPasswordReset(email)`. Shape becomes identical to `apps/admin/lib/firebase/auth_context.tsx`. (Future consolidation into `packages/firebase-auth-web/` is out of scope here.)
- `apps/partners/app/(auth)/login/page.tsx` — replace phone form + reCAPTCHA + OTP screens with email + password form + "forgot password?" link.
- `apps/partners/app/(auth)/forgot-password/page.tsx` (new) — calls `sendPasswordResetEmail`, shows confirmation. Firebase emails the reset link; no backend.
- `apps/partners/app/(auth)/invite/[token]/page.tsx` (new) — reads `token` from route, calls `GET /v1/invitations/lookup`, renders accept form, on submit calls `createUserWithEmailAndPassword` then `POST /v1/invitations/:token/accept`.
- `apps/partners/app/(protected)/no-tenants/page.tsx` (new) — friendly empty state for an authenticated user with zero memberships ("ask your team admin for an invite").
- Remove `<div id="recaptcha-container" />` from `app/layout.tsx`.

### 4.2 Backend

No code changes. `verifyIdToken` validates whichever Firebase provider was used. The `users` schema already has nullable `phone_e164` + unique `email`; the find-or-create path on `GET /v1/me` works unchanged.

### 4.3 Firebase Console

Operator step, documented in `DEPLOYMENT.md`:
- **Enable Email/Password** provider on the `circls-418b6` Firebase project (already on for the admin portal).
- Phone provider stays on (consumer portal will reuse).

### 4.4 Existing test user migration

- Single existing test owner re-signs-up with email at the new login page. Then a one-time SQL UPDATE rewrites their `users.firebase_uid` to the new Firebase user id so existing `tenant_members` rows still resolve. Steps documented in `MEMORY.md` for the next session.

## §5 — Circls-as-tenant bootstrap

### 5.1 Env contract

Add to `apps/api/src/config/env.ts`:

```ts
CIRCLS_INTERNAL_TENANT_SLUG: z.string().default('circls-internal'),
```

API boot sanity check (non-fatal warning if missing):

```ts
const [row] = await db.select({ id: tenants.id })
  .from(tenants)
  .where(and(eq(tenants.slug, env.CIRCLS_INTERNAL_TENANT_SLUG), eq(tenants.isPlatform, true)));
if (!row) logger.warn('circls_internal_tenant_missing — run scripts/bootstrap_circls_tenant.ts');
```

Admin portal `/dashboard` shows a "platform not bootstrapped" banner when this row is absent.

### 5.2 Bootstrap script

`apps/api/scripts/bootstrap_circls_tenant.ts`:

```
DATABASE_URL=… FIREBASE_SERVICE_ACCOUNT=… \
  pnpm bootstrap:circls vedant@gibbous.io "Vedant S"
```

1. If tenant row with `slug=env.CIRCLS_INTERNAL_TENANT_SLUG` exists → "already bootstrapped" and exit 0.
2. Otherwise, in a transaction:
   - INSERT `tenants(slug, name='Circls', is_platform=true, status='active')`.
   - INSERT a `tenant_invitations` row for the supplied founder email with `role='owner'`, 30-day expiry.
3. Print `https://admin.circls.app/invite/<token>` to stdout.
4. Operator clicks the URL, sets a password, becomes the owning Circls member.

### 5.3 Admin portal auth wiring

`apps/admin/app/(protected)/layout.tsx`:
- After Firebase auth resolves, fetch `/v1/me` (which returns the user's tenant memberships).
- Find the membership where `tenant.isPlatform === true`. If none → sign out, redirect to `/login?error=not_circls_team`.
- If found, the active tenant is always that Circls tenant. Admin portal is single-tenant from the user's perspective.

### 5.4 What gets retired

> **Sequencing note:** the deletions below happen *after* `migrate_platform_admin_users.ts` runs successfully against prod — never the same deploy. Otherwise existing platform admins lose access between the env-list removal and the Circls membership being seeded.



- `apps/api/src/middleware/require_platform_admin.ts` deleted.
- `PLATFORM_ADMIN_USER_IDS` env var deleted.
- Every `/v1/admin/*` route now uses `requireCap('admin.tenants.read')` or the relevant specific cap.
- Migration: a one-time script `apps/api/scripts/migrate_platform_admin_users.ts` reads the old env list, finds each user, and INSERTs `tenant_members(tenantId=circls, userId=…, role='manager')`. Documented as a one-shot for the operator.

### 5.5 Circls members who are also in partner tenants

Fully supported by the existing schema. UX: the admin portal scopes everything to the Circls tenant; the user's other memberships are invisible from `admin.circls.app`. They switch to `partners.circls.app` to act on them. Different origins, natural separation.

## §6 — Audit + observability

Every membership-touching mutation writes one `audit_log` row through the existing `writeAudit()` helper. No schema change.

| Action | Entity type | `before` | `after` | `actor_user_id` |
|---|---|---|---|---|
| `tenant.invitation_sent` | `invitation` | null | `{ email, role, expiresAt }` | inviter |
| `tenant.invitation_resent` | `invitation` | `{ tokenPrefix: prev, expiresAt: prev }` | `{ tokenPrefix: next, expiresAt: next }` | inviter |
| `tenant.invitation_revoked` | `invitation` | `{ revokedAt: null }` | `{ revokedAt: now }` | revoker |
| `tenant.invitation_accepted` | `invitation` | `{ acceptedAt: null }` | `{ acceptedAt, acceptedUserId }` | accepting user |
| `tenant.member_added` | `tenant_member` | null | `{ userId, role, source: 'invitation' \| 'bootstrap' }` | accepting user (invitation) / null (bootstrap) |
| `tenant.member_role_changed` | `tenant_member` | `{ role: prev }` | `{ role: next }` | the role-changer |
| `tenant.member_removed` | `tenant_member` | `{ role: prev }` | `{ removedAt: now }` | the remover (or the user themselves on self-remove) |

These rows show up in the existing partner-portal `Settings → Activity log` and in the admin portal's cross-tenant audit search (Phase 16) for free — no new UI work.

A future "Team activity" view is a trivial `?action=tenant.member_*` query on the existing audit-log endpoint — no schema, no service, just a UI page. Not in scope here.

## §7 — Testing strategy

### Unit (no DB)

- `can()` matrix for `PARTNER_CAPS × roles × capabilities` and `PLATFORM_CAPS × roles × capabilities`. Two snapshot tests. Adding a new capability without updating every role row fails the snapshot — default-deny.
- Token generation + bcrypt verify roundtrip.

### Integration (`RUN_INTEGRATION=1`)

1. **Invite lifecycle**: invite sent → `notifications` row queued (channel=email, status=pending) → accept with token → membership exists, audit rows present.
2. **Wrong-email accept**: invite for A, token belongs to B → 403 `invitation_email_mismatch`, no membership.
3. **Resend rotates token**: old token now fails accept; new token succeeds.
4. **Revoke**: revoked invite's token fails accept.
5. **Expiry**: invite past `expires_at` fails accept; resend bumps `expires_at` and works.
6. **Duplicate live invite blocked**: two POSTs same email → 409 from the partial unique index.
7. **Member role change broadens permissions**: same session sees a 403 turn into 200 after the role bump.
8. **Last-owner safeguards**:
   - Demote sole owner → 409 `last_owner_protected`.
   - Remove sole owner → 409 `last_owner_protected`.
   - With ≥2 owners, both operations succeed.
9. **Owner transfer flow**: owner promotes a manager → demotes self → succeeds in 2 calls; audit shows both events.
10. **Cross-tenant isolation**: invite to tenant A doesn't surface in tenant B's invites list filtered by the same email.
11. **`is_platform` routing**: a `manager` in the Circls tenant has `admin.payouts.execute`; same role in a partner tenant doesn't.
12. **Phase 16 → Circls migration**: a user previously in `PLATFORM_ADMIN_USER_IDS`, after the migration script, has equivalent admin caps via Circls membership.

### E2E (deferred, documented)

Playwright: open invite link → set password → land on dashboard → see correct tenant name. Wired in a follow-up.

## §8 — Code that this design displaces

Flagged so the implementation plan does not accidentally preserve them:

- `apps/api/src/middleware/require_admin.ts` → replaced by specific `requireCap(...)` calls.
- `apps/api/src/middleware/require_platform_admin.ts` + `PLATFORM_ADMIN_USER_IDS` env var → replaced by `requireCap('admin.tenants.read')` + Circls membership.
- `apps/partners/lib/firebase/auth_context.tsx`'s `sendOtp` → replaced by `signInWithEmail` / `sendPasswordReset`.
- `apps/partners/app/(auth)/login/page.tsx` phone form + reCAPTCHA + OTP screens → replaced by email/password form.
- `<div id="recaptcha-container" />` in `apps/partners/app/layout.tsx` → removed.

Outside this design's scope but worth flagging because sub-project A may delete them entirely:

- `apps/api/src/routes/kyc.ts` + `apps/api/src/services/kyc_service.ts` + `apps/api/src/services/kyc_documents_service.ts` + `apps/partners/app/(protected)/settings/kyc/**` — Phase 11 KYC stack, no longer needed if Circls is the merchant.

## §9 — Open questions / out of scope

- **Consumer portal auth.** Phone-OTP almost certainly stays (typing a password to book a court is friction). Confirmed in sub-project E.
- **Tenant deletion.** Cap exists (`tenant.delete`) but the actual delete flow (cascade, archival, audit) is its own design; out of scope here.
- **Invitation digest emails / nag reminders.** Not in MVP. The send → click cycle is one-shot.
- **2FA.** Not in MVP. Firebase Auth supports TOTP if we want it; can layer in without schema changes.

## Implementation plan

Pending — written via `superpowers:writing-plans` once this design is approved.
