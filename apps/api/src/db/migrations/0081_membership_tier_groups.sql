-- Partner-named groups for a membership's plans.
--
-- WHY: a membership can carry up to 20 plans, and one live membership already
-- lists 15 day passes, punch cards, memberships and classes in a single list.
-- The partner now names groups (name + one-line tagline) and puts each plan in
-- one; customers see a tab per group. Groups are presentation only, so they
-- can change while the membership is live (unlike prices and durations).
--
-- `tier_groups` holds the ordered groups as jsonb ([{key, name, tagline}]);
-- `membership_tiers.group_key` points a plan at one of them by key. Existing
-- rows get no groups, so every plan keeps showing in one list.

ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "tier_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD COLUMN IF NOT EXISTS "group_key" text;
