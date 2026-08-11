-- Follow-up to 0043 (code review of PR #173). 0043 identified a deleted account
-- by re-keying `firebase_uid` to a `deleted:<id>` sentinel. That had two holes:
--
--   1. RESURRECTION WINDOW. Between the deletion transaction committing and the
--      Firebase teardown finishing, any concurrent authenticated request looked
--      the caller's real uid up, found nothing (it had just been re-keyed), and
--      minted a FRESH users row straight from the token's phone/email claims —
--      silently undoing the deletion and restoring the PII.
--   2. Nothing could RECOGNISE a returning deleted account, because the uid that
--      identified it had been thrown away.
--
-- Keeping the real `firebase_uid` on the tombstone fixes both, but it collides
-- with UNIQUE(firebase_uid) if that person ever signs up again. So uniqueness
-- becomes partial — enforced only among LIVE rows, while tombstones may hold a
-- uid historically. `findOrCreateByFirebaseUid` now refuses a uid that resolves
-- to a tombstone instead of creating a row for it.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_firebase_uid_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "users_firebase_uid_live_unique"
  ON "users" ("firebase_uid") WHERE "deleted_at" IS NULL;

-- The tombstone lookup runs only on the cold path (no live row for the uid:
-- first sight, or deleted). The partial unique index above cannot serve it, so
-- give the deleted side its own small index rather than seq-scanning `users` on
-- every first-time sign-in.
CREATE INDEX IF NOT EXISTS "users_firebase_uid_deleted_idx"
  ON "users" ("firebase_uid") WHERE "deleted_at" IS NOT NULL;

-- No backfill is possible or needed: 0043 ships in the same unreleased PR, so no
-- production row can carry the sentinel, and the real uid a sentinel replaced is
-- unrecoverable. A developer database that ran the interim code keeps its
-- `deleted:<id>` tombstones — harmless, since they are deleted rows either way.
