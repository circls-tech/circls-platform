-- Org-scoped (venue-less) events. venue_id becomes nullable; a venue-less event
-- carries its own address/coords/tz (parity with venues). Exactly-one-scope is
-- enforced by a CHECK: venue events keep location columns NULL (location is read
-- from the venue); standalone events require address_json + tz_name.
ALTER TABLE "events" ALTER COLUMN "venue_id" DROP NOT NULL;
ALTER TABLE "events" ADD COLUMN "address_json" jsonb;
ALTER TABLE "events" ADD COLUMN "lat" double precision;
ALTER TABLE "events" ADD COLUMN "lng" double precision;
ALTER TABLE "events" ADD COLUMN "tz_name" text;

ALTER TABLE "events" ADD CONSTRAINT "events_scope_chk" CHECK (
  (venue_id IS NOT NULL
     AND address_json IS NULL AND lat IS NULL AND lng IS NULL AND tz_name IS NULL)
  OR
  (venue_id IS NULL
     AND address_json IS NOT NULL AND tz_name IS NOT NULL)
);
