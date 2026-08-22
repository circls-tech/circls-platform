-- Focal point + intrinsic dimensions for gallery images.
--
-- WHY: every consumer surface renders photos in a fixed-height `object-cover`
-- box, so a portrait poster gets centre-cropped through its middle and loses
-- its title. `focal_x`/`focal_y` (0..1, default dead-centre = today's crop) map
-- straight to CSS `object-position`, letting the partner choose which part of
-- the photo survives the card crop.
--
-- `width`/`height` are the image's intrinsic pixel size, used to give detail
-- heroes an aspect-correct box (so the whole poster shows, uncropped) and to
-- reserve layout space. They are NULLABLE on purpose: every pre-existing row
-- has none, and NULL is the signal to fall back to the old fixed-height crop.
-- No backfill needed.
--
-- TRUST: unlike size/mime (re-read from R2 via HEAD at finalize), dimensions
-- come from the browser — HEAD cannot report pixel dimensions. They are purely
-- cosmetic (worst case: a mis-proportioned box), never used for authz, billing,
-- or storage accounting, and are range-checked at the API boundary.

ALTER TABLE "event_images"
  ADD COLUMN "width" integer,
  ADD COLUMN "height" integer,
  ADD COLUMN "focal_x" real NOT NULL DEFAULT 0.5,
  ADD COLUMN "focal_y" real NOT NULL DEFAULT 0.5;
--> statement-breakpoint
ALTER TABLE "event_images"
  ADD CONSTRAINT "event_images_focal_chk" CHECK (
    focal_x BETWEEN 0 AND 1 AND focal_y BETWEEN 0 AND 1);
--> statement-breakpoint
ALTER TABLE "event_images"
  ADD CONSTRAINT "event_images_dimensions_chk" CHECK (
    (width IS NULL OR width BETWEEN 1 AND 20000)
    AND (height IS NULL OR height BETWEEN 1 AND 20000));
--> statement-breakpoint
ALTER TABLE "venue_images"
  ADD COLUMN "width" integer,
  ADD COLUMN "height" integer,
  ADD COLUMN "focal_x" real NOT NULL DEFAULT 0.5,
  ADD COLUMN "focal_y" real NOT NULL DEFAULT 0.5;
--> statement-breakpoint
ALTER TABLE "venue_images"
  ADD CONSTRAINT "venue_images_focal_chk" CHECK (
    focal_x BETWEEN 0 AND 1 AND focal_y BETWEEN 0 AND 1);
--> statement-breakpoint
ALTER TABLE "venue_images"
  ADD CONSTRAINT "venue_images_dimensions_chk" CHECK (
    (width IS NULL OR width BETWEEN 1 AND 20000)
    AND (height IS NULL OR height BETWEEN 1 AND 20000));
