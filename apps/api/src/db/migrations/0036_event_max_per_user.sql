-- Optional per-customer ticket cap on events. null = no limit. When set, one
-- user may hold at most this many tickets for the event in total, summed
-- across ALL ticket tiers and all their non-cancelled bookings (e.g. 1 on a
-- free multi-slot RSVP event, so one person can't hold seats in every slot
-- and no-show).

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "max_per_user" integer;
