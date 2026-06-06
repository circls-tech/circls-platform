# Security Review — Circls Platform API (M4)

**Date:** 2026-06-01 · **Scope:** `apps/api` (auth, payments, admin authz, multi-tenant isolation, public endpoints, secrets/config) · **Method:** 5 parallel surface audits + adversarial verification of the top findings.

Severity: **Critical** = auth bypass / act-as-another-user / steal funds · **High** = privilege or cross-tenant escalation, fail-open verification · **Medium** = integrity/validation gaps, races · **Low** = hardening / dead config.

---

## Spec-flagged items — verdicts

| Item (from design spec) | Verdict |
|---|---|
| `admin_refunds.ts` `ADMIN_USER_IDS` backdoor | **NON-ISSUE** — the env var is dead config, read nowhere; admin is a proper capability model. Remove the dead var (L1). |
| Razorpay webhook HMAC verification | **Correct** in live mode (raw body, `timingSafeEqual`, fails closed). BUT fails **open** in stub mode (H1). |
| Firebase ID-token verification | **Correct** (Admin SDK verifies signature/expiry/iss/aud). Gap: no `checkRevoked` (M5); no `email_verified` gate (C1). |
| `computeCommissionPaise()` returning 0 | **Not a stub** — math is correct. The 0 comes from the DB default `commission_bps = 0` (H7). |
| `acceptInvitation` uid-mismatch | **CONFIRMED Critical** (C1) — but the real vuln is uid-adoption on an unverified email, not the email-match guard. |
| silent error-swallow (invitations) | **Non-issue** — best-effort notification dispatch; does not turn failed auth into success. |

---

## CRITICAL

### C1 — Account takeover via unverified-email identity adoption  *(verified)*
**Where:** `middleware/require_auth.ts:40` (`email: decoded.email ?? null` — no `email_verified` gate) → `services/user_service.ts:62-88` `adoptStaleIdentity` **UPDATEs an existing row's `firebase_uid`** when the token email/phone matches; reachable via `routes/me.ts` / `middleware/current_user.ts` on first call. Also via the **unauthenticated** `routes/invitations.ts:126` → `services/invitation_service.ts:304-316`.
**Exploit:** Attacker registers a Firebase email/password account using the victim's email (email/password signup yields `email_verified=false` but a valid token), then calls `GET /v1/me` (or accepts any invite addressed to that email). `adoptStaleIdentity` re-points the victim's `users` row — and all its tenant memberships, bookings, payments (keyed on `users.id`) — onto the attacker's uid. No null-uid precondition, so it overwrites live accounts. Preconditions: know the victim's email. Confidence 90.
**Fix (one chokepoint):** in `require_auth.ts` set `email: decoded.email_verified ? (decoded.email ?? null) : null` (phone from Firebase phone-auth is inherently verified). Reject `!decoded.email_verified` in the invitation-accept handler. Defense-in-depth: `adoptStaleIdentity` must refuse to migrate a row whose `firebase_uid` is already non-null.

---

## HIGH

### H1 — Razorpay webhook fails OPEN in stub mode  *(verified)*
**Where:** `lib/razorpay.ts:72-75` (`StubRazorpay.verifyWebhookSignature` returns `true`), selected by `getRazorpay()` (`:163-176`) whenever `RAZORPAY_KEY_ID`/`SECRET` is empty; all three `RAZORPAY_*` are `z.string().optional()` in `config/env.ts:29-31` (no prod guard).
**Exploit:** If prod ever boots without the Razorpay env vars, an unauthenticated attacker POSTs forged `payment.captured` events to mark bookings paid / drive payout state. Confidence 90.
**Fix:** `superRefine` in `env.ts` requiring the 3 `RAZORPAY_*` secrets non-empty when `NODE_ENV==='production'` (refuse boot otherwise); have the webhook route 503 if `getRazorpay().mode === 'stub'` in prod. **Also confirm Coolify prod currently has these set.**

### H2 — API-key `role`/`scopes` never enforced
**Where:** `middleware/require_api_key.ts:25-41`; write path `routes/public_bookings.ts` `POST /api/v1/bookings`. Keys store `role`/`scopes` but no route reads them.
**Exploit:** a key issued as `role:'read'` can create real bookings. Confidence 90.
**Fix:** enforce role on write endpoints (`requireApiKeyRole('write')`); enforce or drop `scopes`.

### H3 — Any tenant member (incl. read-only) can mint/revoke API keys, including `admin`-role keys
**Where:** `routes/api_keys.ts:16-45` — checks `requireTenantMembership` only, never `assertCap`.
**Exploit:** a `readonly` member POSTs an `admin`-role key → self privilege-escalation (combined with H2, full write); can also revoke legitimate keys (DoS). Confidence 88.
**Fix:** add an `integration.api_keys.manage` capability (owner/manager) and `assertCap` in all three handlers; forbid issuing a key whose role exceeds the caller's.

### H4 — Null-tenant ("platform") API keys grant unaudited cross-tenant access
**Where:** `routes/public_bookings.ts:60-63,114-117` (treat `apiTenantId===null` as cross-tenant); `services/api_keys_service.ts:65-75,142-146` (platform-key creation not audited).
**Exploit:** a single leaked platform key reads/books across every tenant, with no audit trail. Confidence 84.
**Fix:** require an explicit platform capability to mint/use null-tenant keys; unconditionally audit platform-key create/revoke.

### H5 — Cross-tenant slot enumeration via `arenaId`  *(verified)*
**Where:** `routes/public_bookings.ts:65-66` (`arenaId ? [{id:arenaId}] : listArenas(venueId)`) → `services/slot_service.ts:243-278` `listSlots` (no tenant filter). The tenant check is on the *venue*, not the arena it actually reads.
**Exploit:** a tenant-scoped key passes its own `venueId` (clears the 403) + another tenant's `arenaId` → reads that arena's open slots (times/prices/availability). Confidence 90.
**Fix:** resolve the arena and assert `arena.venueId === venueId` before listing slots.

### H6 — CORS reflects any origin with credentials  *(verified)*
**Where:** `server.ts:71` — `register(cors, { origin: true, credentials: true })`.
**Exploit:** any website can make credentialed cross-origin calls; low impact today (Bearer auth, not cookies) but unsafe and will leak the moment any ambient auth is added. Confidence 80.
**Fix:** explicit origin allow-list from env (admin/partners/consumer origins).

### H7 — Platform commission is silently 0 in production *(revenue, not strictly security)*
**Where:** DB default `tenants.commission_bps = 0` (`db/schema/tenants.ts`, `migrations/0012_*.sql:33`); `payout_service.ts:121-129` falls back to 0 for unconfigured tenants. The function math is correct.
**Impact:** Circls collects as merchant and pays out 100% of gross to venues — earns nothing — until each tenant's rate is set. Confidence 90.
**Fix:** non-zero `DEFAULT` + backfill existing tenants; assert/alert in reconcile when a tenant with gross>0 has `commission_bps=0`; add an admin write path for the rate.

---

## MEDIUM

- **M1 — `payment.captured` doesn't verify captured amount == order amount** (`services/payments_service.ts:149-217`). Add `assert entity.amount === pay.amountPaise` + currency before flipping to captured. (Defense-in-depth behind the signature gate.)
- **M2 — `refund.processed` webhook is an unimplemented stub** (`payments_service.ts:285-293`) → refund ledger can drift (async refunds never reconciled; affects payout deductions). Implement it idempotently.
- **M3 — Refund "remaining" check is not concurrency-safe** (`services/refund_service.ts:63-97`) → two concurrent refunds/cancels can over-refund. Add `SELECT … FOR UPDATE` on the charge.
- **M4 — Webhook capture/fail idempotency keys on row state, no `FOR UPDATE`** (`payments_service.ts:172-176,239-243`) → concurrent duplicate deliveries can double-confirm / double-notify. Status-guard the UPDATE or add a `processed_webhook_events(event_id)` table.
- **M5 — ID-token revocation not checked** (`lib/firebase_admin.ts:43`) → disabled/revoked accounts stay valid up to 1h. Use `verifyIdToken(token, true)` at least on role-mutating/invite paths.
- **M6 — No rate limiting** on anonymous browse + hold/booking/purchase (`server.ts`, `routes/consumer.ts`, `slots.ts` hold, `public_bookings.ts`). Register `@fastify/rate-limit`.
- **M7 — `admin_refunds` bespoke authz + broad error swallow** (`routes/admin_refunds.ts:60-80`) — `role==='owner'` string check + `try/catch` that masks DB errors as "not allowed." Use a `payments.refund` capability; narrow the catch.
- **M8 — Invitation plaintext token returned in create/resend responses** (`routes/invitations.ts:43-46,78-83`) — bearer secret exposed to response logs. Gate behind non-prod.

## LOW

- **L1 — Remove dead `ADMIN_USER_IDS` config** (`config/env.ts:67-78`) — misleading; read nowhere.
- **L2 — Aggregator bookings impersonate a tenant owner as audit actor** (`routes/public_bookings.ts:120-176`) — corrupts accountability. Use a dedicated `kind='system'` user + stamp the key id.
- **L3 — Hardcoded Firebase **Web** API key** (admin/partners/consumer `lib/firebase/client.ts`) — public by design, not a leak; optionally add GCP referrer restrictions.
- **L4 — No pino `redact`** (`lib/logger.ts`, `server.ts`) — defense-in-depth so a future `req.log.info({headers})` can't leak tokens.
- **L5 — Global JSON parser registered from the webhook plugin** (`routes/webhooks_razorpay.ts:19-31`) — works but order-fragile (HMAC correctness depends on registration order). Register raw-body capture at server scope.

---

## Recommended fix order
1. **C1 immediately** (active account-takeover on a launching product; small chokepoint fix).
2. **H1–H5** (fail-open verification + API-key authz holes + cross-tenant leak) — confirm Coolify has the Razorpay secrets set as part of H1.
3. **H6, H7, M1–M8** through the daily release pipeline.
4. **L1–L5** as hygiene, batched.

All fixes ship via the new M3 pipeline (PR → CI → operator release), TDD where logic is involved.
