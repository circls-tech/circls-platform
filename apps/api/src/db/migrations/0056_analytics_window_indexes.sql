-- The partner dashboard reads a tenant's money and sales for one week. Both
-- filter on tenant_id and created_at, but the only indexes were on tenant_id
-- alone, so every load scanned that tenant's entire history and the cost grew
-- with every sale they ever made. These let the week be seeked to directly.
CREATE INDEX IF NOT EXISTS "payments_tenant_created_idx"
  ON "payments" ("tenant_id", "created_at");

CREATE INDEX IF NOT EXISTS "bookings_tenant_created_idx"
  ON "bookings" ("tenant_id", "created_at");

-- Free, coupon-less membership purchases have no bookings row, so the same
-- dashboard reads them straight from user_memberships for the week.
CREATE INDEX IF NOT EXISTS "user_memberships_created_idx"
  ON "user_memberships" ("created_at");
