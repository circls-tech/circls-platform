# Questions (support threads) on events, arenas & memberships — design

**Date:** 2026-07-18
**Status:** Approved (product owned by Claude per delegation; supersedes the "no two-way support" scope note in #114/#115 deliberately)
**Related:** epic #106 (consumer trust & support), #114 (support concerns backend), #115 (Help chatbot), #116 (admin concerns view)

## 1. Product summary

Consumers can ask questions on any **event**, **arena**, or **membership**. Each question starts a **thread**: a first message plus chronological replies (single level, chat-style — no nesting).

Two visibility types, chosen at creation and **immutable afterwards**:

- **Private** — visible to the thread author, members of the org (tenant) that owns the subject, and the Circls team. Only those parties can reply.
- **Public** — readable by everyone (including signed-out visitors); any signed-in user can reply, plus the org and the Circls team.

Replies from the org show an **Organizer** badge; replies from Circls staff show a **Circls** badge.

Thread status lifecycle: `open → answered → closed`.

- New thread → `open`.
- Org or Circls reply on an `open` thread → auto-`answered`.
- Author reply on an `answered` thread → back to `open` (reopen). Replies on `closed` threads are rejected (author must not be able to necro a closed thread; org/admin replies on closed threads are also rejected — reopen first via status PATCH).
- Author, org, or Circls can set `answered` or `closed` explicitly; org/Circls can also reopen (`open`).

Moderation (public threads only): the org can **hide** any reply on threads attached to its own subjects, except the root message; Circls admin can hide any message (root included — hiding the root effectively removes the question from public view but thread stays visible to author/org/admin with a "hidden" marker). Hidden messages remain visible (marked) to the org/admin and the message author; other viewers don't see them.

**Archiving (thread-level moderation, any visibility):** the org and Circls admin can **archive** a whole thread — protection against malicious/abusive forum use. An archived thread disappears from **every consumer surface**: excluded from the public list and `/mine`, and detail/replies/author-PATCH 404 `question_not_found` for every consumer-surface viewer **including the thread author** (org/circls members hitting the consumer endpoint still see the detail, consistent with their staff access). Staff keep full access via an `archived=true` list view; staff replies, status PATCHes and hide/unhide on an archived thread are rejected 409 `question_archived` (unarchive first). Hierarchy mirrors hide/unhide: re-archiving is an idempotent no-op that never overwrites `archived_by_kind`; the org can only unarchive its own archives (else 403 `forbidden_moderation`), Circls can unarchive anything. Silent action — no notifications/emails on archive or unarchive.

Out of scope for v1 (explicitly deferred): attachments, editing/deleting messages, upvotes, converting private↔public, webhook events (`question.*`), SEO/server-rendering of public threads, realtime (polling/refetch only), org email digests.

## 2. Data model (Drizzle, Postgres 18)

Follow `apps/api/src/db/schema/_columns.ts` conventions (uuidv7 PK, timestamptz created/updated). New schema files `question_threads.ts`, `question_messages.ts` + barrel export. Migration `0036_question_threads.sql` (idempotent/additive style like `0026_support_concerns.sql`; renumber at merge if it collides).

### `question_threads`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | uuidv7() |
| `tenant_id` | uuid notNull FK→tenants | denormalized owner of the subject; drives org authz |
| `subject_type` | enum `question_subject_type('event'\|'arena'\|'membership')` | |
| `event_id` | uuid null FK→events | |
| `arena_id` | uuid null FK→arenas | |
| `membership_id` | uuid null FK→memberships | |
| `visibility` | enum `question_visibility('public'\|'private')` | immutable |
| `status` | enum `question_status('open'\|'answered'\|'closed')` | default `open` |
| `author_user_id` | uuid notNull FK→users | |
| `last_message_at` | timestamptz notNull default now | bump on every message; sort key |
| `message_count` | integer notNull default 1 | maintained transactionally |
| `archived_at` | timestamptz null | thread-level moderation: hidden from all consumer surfaces |
| `archived_by_user_id` | uuid null FK→users | |
| `archived_by_kind` | text null (`'org'`\|`'circls'` + CHECK) | unarchive hierarchy, same style as `question_messages.hidden_by_kind` |
| `created_at`/`updated_at` | timestamptz | |

CHECK constraint: exactly one of `event_id`/`arena_id`/`membership_id` set, matching `subject_type`. Indexes: `(tenant_id, status, last_message_at desc)`, `(subject_type, event_id/arena_id/membership_id, visibility, last_message_at desc)` (partial per subject col), `(author_user_id, last_message_at desc)`.

### `question_messages`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `thread_id` | uuid notNull FK→question_threads ON DELETE CASCADE | |
| `author_user_id` | uuid notNull FK→users | |
| `author_kind` | enum `question_author_kind('consumer'\|'org'\|'circls')` | stamped at write time from the poster's relationship to the thread |
| `body` | text notNull | 1–2000 chars, trimmed, non-empty |
| `hidden_at` | timestamptz null | moderation |
| `hidden_by_user_id` | uuid null FK→users | |
| `created_at`/`updated_at` | | |

Index `(thread_id, created_at asc, id)`. The **root message** is the earliest message of the thread (no special flag). Thread creation inserts thread + root message in one transaction.

`author_kind` resolution at post time: member of platform tenant → `circls`; else member of `thread.tenant_id` → `org`; else `consumer`. (A user who is both asker and org member posts as `org` — acceptable edge.)

## 3. API surface (`apps/api`)

New route file `src/routes/questions.ts` + service `src/services/questions_service.ts`. Zod validation, `AppError` codes, cursor pagination (`{ rows, nextCursor }`, cursor = `` `${lastMessageAtIso}|${id}` ``), limits `min(limit ?? 20, 50)`. Serialized author display: each message carries `authorName` (users.display_name ?? 'Member'; for `org` kind use tenant name; for `circls` use 'Circls team') and `authorKind`.

### Consumer (`/v1/consumer/questions…`)

- `GET /v1/consumer/questions?subjectType=&subjectId=&cursor=&limit=` — **no auth required**. Public threads for a subject, newest-activity first. Each row: thread fields + `rootBody` excerpt (first 280 chars of root message) + `replyCount`. Threads whose root message is hidden are excluded from this public list.
- `GET /v1/consumer/questions/mine?subjectType=&subjectId=&cursor=` — auth. The caller's own threads (both visibilities), optional subject filter (used to surface "your private questions" on detail pages and the `/me/questions` list).
- `POST /v1/consumer/questions` — auth. Body `{ subjectType, subjectId, visibility, body }`. Validates subject exists & is publicly visible (event status `published`, arena `active`, membership `active` — reuse consumer_service visibility rules), resolves `tenant_id` from subject (arena → venue → tenant). Rate limit: max 10 threads per user per 24h (count in SQL, error `question_rate_limited`).
- `GET /v1/consumer/questions/:threadId` — public thread: no auth. Private thread: auth + author-only (403/404 `question_not_found` for non-authors — use 404 to avoid existence leaks). Returns thread + full message list (asc). Hidden messages included only for viewers allowed to see them (author of the hidden message, org, circls); otherwise omitted.
- `POST /v1/consumer/questions/:threadId/messages` — auth. Body `{ body }`. Allowed: thread author (any visibility), any signed-in user on public threads, org/circls members (they may also use their own surfaces). Rejected on `closed` (409 `question_closed`). Rate limit 60 messages/user/24h. Applies status transitions (§1) based on stamped `author_kind`.
- `PATCH /v1/consumer/questions/:threadId` — auth, author only. Body `{ status: 'answered'|'closed' }` (author cannot reopen a closed thread; asking again = new thread).

### Partner (`/v1/tenants/:tenantId/questions…`)

Authz: `currentUser` → `requireTenantMembership` → `assertCap`. New capabilities in `src/lib/authz/capabilities.ts`: `questions.read`, `questions.write`. Grants in `role_caps.ts` (PARTNER_CAPS): read → all roles incl. `readonly`; write → `owner`, `manager`, `staff`.

- `GET /v1/tenants/:tenantId/questions?status=&visibility=&subjectType=&archived=&cursor=` — org inbox, threads on the tenant's subjects, newest-activity first, with `rootBody`, `replyCount`, subject summary `{ type, id, name }`. `archived` (`'true'|'false'`, default `'false'`) selects the archived view; staff rows/detail serializations carry `archivedAt` + `archivedByKind` (never on consumer payloads).
- `GET /v1/tenants/:tenantId/questions/summary` — `{ openCount }` for the sidebar badge (archived threads excluded).
- `GET /v1/tenants/:tenantId/questions/:threadId` — thread + messages (hidden ones marked, not omitted).
- `POST /v1/tenants/:tenantId/questions/:threadId/messages` — reply (`questions.write`); stamps `author_kind='org'`; auto-`answered` when `open`; 409 `question_closed` on closed threads (same rule as consumer replies; applies to the admin reply endpoint too); 409 `question_archived` on archived threads.
- `PATCH /v1/tenants/:tenantId/questions/:threadId` — `{ status }` any of the three (`questions.write`); 409 `question_archived` on archived threads.
- `POST /v1/tenants/:tenantId/questions/:threadId/messages/:messageId/hide` and `/unhide` — public threads only, not the root message (`questions.write`). 400 `cannot_hide_root` / `not_public_thread`; 409 `question_archived` on archived threads.
- `POST /v1/tenants/:tenantId/questions/:threadId/archive` and `/unarchive` (`questions.write`) — returns the serialized thread. Archive is an idempotent no-op on an already-archived thread (never overwrites `archived_by_kind`); unarchive allowed only when `archived_by_kind='org'` (else 403 `forbidden_moderation`).

### Admin (`/v1/admin/questions…`)

Authz triad with `getPlatformTenantId()`. New capabilities `admin.support.read`, `admin.support.write` in PLATFORM_CAPS (per #114's recommendation; existing support_issues gates left untouched this PR).

- `GET /v1/admin/questions?status=&visibility=&subjectType=&tenantId=&archived=&cursor=` — same `archived` semantics as the partner list.
- `GET /v1/admin/questions/:threadId`
- `POST /v1/admin/questions/:threadId/messages` — `author_kind='circls'`; auto-`answered` when `open`; 409 `question_archived` on archived threads (as are status PATCH and hide/unhide).
- `PATCH /v1/admin/questions/:threadId` — status.
- `POST .../messages/:messageId/hide` / `/unhide` — any message incl. root, public threads only.
- `POST /v1/admin/questions/:threadId/archive` and `/unarchive` (`admin.support.write`) — Circls can always unarchive, org archives included; archive is the same no-op-preserving idempotent write as the partner endpoint.

## 4. Notifications

Via `notification_hooks.ts`-style best-effort shim (never throw):

- **Org gets email on new thread**: template `question.asked` → tenant `contact_email` (skip if unset). Payload: subject name, excerpt, visibility, portal link.
- **Author gets email on org/circls reply**: template `question.replied` → author's `users.email` (skip if unset). No email on consumer replies to public threads.

Ledger rows via `DefaultDispatcher` as with booking templates. No webhooks in v1.

## 5. Consumer UI (`apps/consumer`)

New shared module `components/questions/` (+ hooks in `lib/api/questions.ts`, types in `lib/api/types.ts`):

- **`QuestionsSection`** — inline section: public threads list (excerpt cards with status pill, reply count, relative time) + "your questions" strip (auth, from `/mine` with subject filter) + **Ask a question** button. Paginate with a "Show more" button (`useInfiniteQuery`).
- **`AskQuestionModal`** — Modal (existing `lib/ui/Modal.tsx`): textarea + visibility choice (radio cards: "Public — anyone can see and reply" / "Private — only you and the organiser"). Requires sign-in → redirect `/login?redirect=…` pattern.
- **`ThreadView`** — slide-over panel (portal + `mounted` guard, HelpWidget pattern) showing the chat transcript with `Bubble`-style messages (author name + Organizer/Circls badges), reply composer, and author-only "Mark answered"/"Close" actions.
- Placement:
  - Event detail `app/events/[id]/page.tsx` — `QuestionsSection` below the org block.
  - Membership detail `app/memberships/[id]/page.tsx` — same.
  - Venue detail `app/venues/[venueId]/page.tsx` — each `ArenaCard` gets a "Questions · N" affordance opening the slide-over with that arena's `QuestionsSection`.
- **`/me/questions`** — new page listing the user's threads (all subjects), linking into `ThreadView`; add a "My questions" link where `/me/bookings` nav lives (header/account menu).
- Feedback inline (no toasts), single light theme, English copy — match app conventions.

## 6. Partner portal UI (`apps/partners`)

- Sidebar `NAV_LINKS` + `/questions` entry ("Questions") with an open-count badge (from `/summary`, polled via React Query `refetchInterval` 60s).
- **Inbox** `app/(protected)/questions/page.tsx` — tabs Open / Answered / Closed (help-page tab pattern), filters (visibility, subject type), infinite scroll (notifications pattern). Rows: subject name + type badge, excerpt, visibility badge, reply count, last activity (org timezone via `useTimezone`).
- **Thread detail** `app/(protected)/questions/[threadId]/page.tsx` — full page: subject header (link to the event/membership/arena page), transcript (visitor messages left, org/circls right), reply composer, status controls (StatusPill + actions), hide/unhide on public replies.
- Hooks in `lib/api/questions.ts`, types in `lib/api/types.ts`, `Idempotency-Key` **not** needed (replies are cheap; server dedupe unnecessary in v1).
- **Help Centre (same PR, mandatory):** new `content/help/questions.md` + `HELP_ARTICLES` entry (category `Support`, quickLink) + README map row; add short "Customer questions" sections to `events.md`, `memberships.md`, `venues.md`; update `team.md` role capabilities table (readonly = view questions, staff+ = reply/manage).

## 7. Admin UI (`apps/admin`)

- Nav entry "Questions" → `app/(protected)/questions/page.tsx` list (mirror support-issues page: filter bar incl. tenant, status/visibility badges) + `questions/[threadId]/page.tsx` detail with transcript, reply composer, status select, hide/unhide any message. Hooks in `lib/api/queries.ts`, types in `lib/api/types.ts`.

## 8. Testing & verification

- **API integration tests** `src/routes/questions.test.ts` following `support_concerns.test.ts` (RUN_INTEGRATION-gated): consumer ask (public+private), visibility enforcement (non-author 404 on private; signed-out read public), reply permissions (public vs private), closed-thread rejection, status auto-transitions, org inbox + capability denial for a non-member, admin reply + hide, rate limit, root-hide rules, pagination.
- **Unit**: status-transition + author_kind resolution helpers as pure functions with unit tests.
- `can.test.ts` snapshot updated for new capabilities.
- `pnpm -r typecheck && pnpm -r lint && pnpm -r test`; sandbox E2E walkthrough (seeded org + consumer: ask private → org reply → answered → author reopen → close; public thread with third-party reply; admin hide).

## 9. Rollout

Single PR against `main` (branch `worktree-questions-threads`), migration `0036`, no env/infra changes. Feature is additive; no data backfill.
