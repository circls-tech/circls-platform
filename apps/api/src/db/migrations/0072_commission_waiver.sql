-- Commission-free period: every org was promised its first 3 months without
-- partner commission, counted from its first paid booking. Record-only — the
-- charge paths still take commission_bps, so admins keep that at 0% until the
-- period ends.
--
-- Both dates are admin overrides. NULL start = the org's first paid booking;
-- NULL end = start + 3 months (see services/commission_waiver.ts), so no
-- backfill is needed. The end date is the day commission starts.
--
-- commission_after_waiver_bps is the rate agreed for after the period — shown
-- to the partner, never charged by itself. NULL = not decided / not shown.

ALTER TABLE "tenants"
  ADD COLUMN "commission_waiver_starts_on" date,
  ADD COLUMN "commission_waiver_ends_on" date,
  ADD COLUMN "commission_after_waiver_bps" integer;
--> statement-breakpoint
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_commission_waiver_chk" CHECK (
    (commission_after_waiver_bps IS NULL OR commission_after_waiver_bps BETWEEN 0 AND 10000)
    AND (commission_waiver_starts_on IS NULL
         OR commission_waiver_ends_on IS NULL
         OR commission_waiver_ends_on >= commission_waiver_starts_on));
