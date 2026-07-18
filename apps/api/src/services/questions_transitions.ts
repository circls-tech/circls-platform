/**
 * Pure helpers for the Questions feature: author_kind stamping and the
 * status-transition rules from the design doc (docs/superpowers/specs/
 * 2026-07-18-questions-threads-design.md §1). Kept side-effect free so they
 * are trivially unit-testable; questions_service.ts owns the DB work.
 */
import type { QuestionAuthorKind } from '../db/schema/question_messages.js';
import type { QuestionStatus } from '../db/schema/question_threads.js';

/**
 * Resolve who a poster writes *as*, from their resolved write capabilities
 * (not bare membership — a `readonly` member must not speak for the org):
 * `admin.support.write` on the platform tenant → `circls`; `questions.write`
 * on the thread's tenant → `org`; everyone else → `consumer`. A user who is
 * both the asker and a cap-holding org member posts as `org` (accepted edge
 * per the design doc).
 */
export function resolveAuthorKind(opts: {
  canPostAsCircls: boolean;
  canPostAsOrg: boolean;
}): QuestionAuthorKind {
  if (opts.canPostAsCircls) return 'circls';
  if (opts.canPostAsOrg) return 'org';
  return 'consumer';
}

/**
 * Status after a reply lands (replies on `closed` threads are rejected before
 * this is called — passing `closed` returns it unchanged):
 * - org/circls reply on `open` → `answered`
 * - thread-author reply (as a consumer) on `answered` → back to `open`
 * - anything else → unchanged
 */
export function nextStatusOnReply(
  current: QuestionStatus,
  authorKind: QuestionAuthorKind,
  isThreadAuthor: boolean,
): QuestionStatus {
  if (current === 'open' && (authorKind === 'org' || authorKind === 'circls')) {
    return 'answered';
  }
  if (current === 'answered' && isThreadAuthor && authorKind === 'consumer') {
    return 'open';
  }
  return current;
}

/** Statuses the thread author may set explicitly (no reopen of closed threads). */
export type AuthorPatchStatus = Extract<QuestionStatus, 'answered' | 'closed'>;

/**
 * Validate an explicit author status change. The author can mark `answered`
 * or `closed`, but never resurrect a `closed` thread (asking again = a new
 * thread) — so from `closed`, only the idempotent `closed` is allowed.
 * Returns the new status, or null when the change is not permitted.
 */
export function applyAuthorStatusPatch(
  current: QuestionStatus,
  requested: AuthorPatchStatus,
): QuestionStatus | null {
  if (current === 'closed' && requested !== 'closed') return null;
  return requested;
}
