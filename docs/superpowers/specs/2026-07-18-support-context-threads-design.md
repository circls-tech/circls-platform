# Support → private threads + resolver context — design

**Date:** 2026-07-18
**Status:** Approved (product owned by Claude per delegation)
**Builds on:** `2026-07-18-questions-threads-design.md` (Questions threads, PR #149). Stacked branch `worktree-support-threads`.

## 1. Product summary

Two changes to make support actually resolvable:

**A. The consumer Help flow now produces a conversation, not a ticket.** The guided interview (MCQ decision tree in the Help widget) is kept as intake, but its terminal step creates a **private question thread** instead of a one-way `support_issues` row. The asker, the relevant org, and the Circls team can then converse in the existing thread system (replies, statuses, auto-transitions, emails, moderation, archiving — all inherited).

- Concern tied to a **booking** (picked in the interview): the thread attaches to the booking's underlying subject — `slot` → the arena, `event` → the event, `membership` → the membership — with the booking pinned as context (`context_booking_id`). Routed to the booking's tenant; org + Circls both see it (private visibility).
- Concern with **no booking** (app/platform questions, "other"): the thread gets the new subject type **`general`**, `tenant_id` = the platform tenant. Visible to asker + Circls team only. `general` threads are **always private** (enforced server-side) and are never listed on any public surface.
- Threads created via the interview carry `origin='support'` (organic asks are `origin='forum'`), plus the interview's `category` and structured `flow_answers` for staff.

**B. Staff get resolver context.** Partner and admin thread detail pages gain a context panel about the asker so whoever resolves the query has real data:

- **Member**: display name, member-since; contact details (email/phone) on **private** threads only (public-thread askers haven't opted into sharing contact info).
- **Pinned booking** (when `context_booking_id` set): item type, what/when, status, amounts, payment method, QR ticket state.
- **Relationship with the tenant** (partner surface, tenant-scoped): recent bookings with this tenant (status/date/amount), active memberships with this tenant, prior question threads with this tenant.
- **Admin surface** additionally: cross-tenant recent bookings, recent consumer activity, prior threads across tenants, and historical `support_issues` by the same user.
- The interview transcript (`flow_answers`) renders as a structured block in staff thread detail (same treatment as the admin support-issues expandable transcript).

**What happens to the old system:** the consumer `POST /v1/consumer/support/concerns` intake is removed (Help widget is its only caller); `GET …/concerns` remains for historical reads. The partner-side "Raise an issue" (`POST /v1/support/issues`, source `partner_help`) and the admin support-issues page stay — the page keeps serving partner issues + historical consumer concerns. No data backfill.

Out of scope: backfilling old concerns into threads, org-side guided flows, SLAs/assignment, attachments.

## 2. Data model changes

On `question_threads` (edit migration in place on the stacked branch — still unreleased; renumber-at-merge rule applies):

| column | type | notes |
|---|---|---|
| `origin` | text notNull default `'forum'` (`'forum'`\|`'support'` + CHECK) | intake channel |
| `category` | text null (existing support category values + CHECK) | set by interview; `booking_issue\|refund_request\|reschedule\|venue_question\|payment\|other` |
| `context_booking_id` | uuid null FK→bookings | pinned booking context |
| `flow_answers` | jsonb null | interview transcript (same shape as `support_issues.flow_answers`) |

- `question_subject_type` enum gains `'general'`; subject CHECK updated: `general` ⇒ all three subject FKs null. `general` ⇒ `visibility='private'` (CHECK).
- Consumer serializations never expose `flow_answers`/context fields beyond `origin`/`category` (harmless); staff serializations expose all.

## 3. API changes

### Thread creation (consumer)

`POST /v1/consumer/questions` accepts an optional support-intake shape alongside the existing one:

- Existing: `{ subjectType: event|arena|membership, subjectId, visibility, body }` → `origin='forum'` (unchanged).
- New: `{ origin: 'support', category, body, bookingId? , flowAnswers? }` — no subjectType/visibility from the client:
  - `bookingId` present: must belong to the caller (`customer_user_id` or `created_by_user_id`, not cancelled); server derives subject from the booking's item (slot→arena via `slot_arena_id`; event→event id from `item_data`; membership→membership id from `item_data`) and `tenant_id` from the booking. If the derived subject row no longer exists, fall back to `general` under the booking's tenant. Sets `context_booking_id`.
  - No `bookingId`: subject `general`, `tenant_id` = platform tenant.
  - Visibility forced `private`. Rate limits, notifications (`question.asked` to tenant contact email — for `general`, the platform tenant's contact email), and everything else inherited.

### Staff context endpoints

- `GET /v1/tenants/:tenantId/questions/:threadId/context` (cap `questions.read`) → `{ member: { id, displayName, memberSince, email?, phone? }, contextBooking?, recentBookings: [...tenant-scoped], memberships: [...tenant-scoped], priorThreads: [...tenant-scoped, id/status/subject/lastMessageAt] }`. `email`/`phone` only when the thread is private. Booking rows: id, itemType, summary label, status, totalPaise/currency, createdAt, timeRange.
- `GET /v1/admin/questions/:threadId/context` (cap `admin.support.read`) → same plus `recentActivity` (consumer_activity, latest N), `priorThreads` cross-tenant, `supportIssues` (historical, by user).
- Staff thread detail responses additionally carry `origin`, `category`, `flowAnswers`, `contextBookingId`.
- Partner/admin list endpoints accept `origin=forum|support` filter; list rows carry `origin` + `category`.

### Removed

- `POST /v1/consumer/support/concerns` → 410 `gone` (or removed from the route table; Help widget is the only caller). `GET` variants stay.

## 4. UI changes

**Consumer (Help widget):** interview flows unchanged until the terminal step; submission now calls the new support-intake creation and the confirmation bubble links "View your conversation" → opens the thread (ThreadView / `/me/questions`). Support threads appear in `/me/questions` like any other private thread (they are threads). Category label shown on the thread card.

**Partners:** inbox rows get an origin indicator (a "Support" badge on `origin='support'` rows + category label) and an origin filter (All / Questions / Support requests). Thread detail gets: the context panel (collapsible Card on the right/below header — member, pinned booking, relationship lists, prior threads) and a structured "Interview answers" block when `flowAnswers` present. Help Centre `questions.md` updated (support requests arrive in the same inbox; what the context panel shows; contact-details privacy rule).

**Admin:** questions list gets origin filter + badges; detail gets the context panel (with cross-tenant extras + historical support issues) and the interview transcript block. The support-issues page gets a one-line banner noting new consumer concerns now arrive as Questions (link), while partner issues remain here.

## 5. Testing

Integration tests: support intake with booking (each item type → correct subject + tenant + private + context fields), without booking (general/platform routing + CHECK enforcement), booking-ownership rejection, general-thread invisibility on all public surfaces + partner inbox exclusion, context endpoint authz (tenant scoping, private-only contact details, admin extras), origin filters, removed concerns POST. UI: existing suites + builds. Sandbox E2E: full interview → thread → org sees context + booking → replies → resolution; no-booking flow → admin-only thread.
