-- Consumer likes: the wishlist behind the heart on event, membership and venue
-- cards. One row per (user, item). item_id is not a foreign key on purpose —
-- the three item types live in three tables, and a listing that is later
-- deleted or unpublished drops out of the wishlist read (which re-applies the
-- public visibility rules) instead of failing the like.
CREATE TYPE "public"."wishlist_item_type" AS ENUM('event', 'membership', 'venue');
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "item_type" "wishlist_item_type" NOT NULL,
  "item_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "item_type", "item_id")
);
--> statement-breakpoint
CREATE INDEX "wishlist_items_user_created_idx" ON "wishlist_items" ("user_id", "created_at");
