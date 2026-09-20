-- The admin dashboard counts bookings in the last 24 hours and 7 days, and now
-- also the distinct customers behind them, but `bookings` carries no index on
-- created_at: every tile load sequentially scanned the whole table. One index
-- serves all three.
CREATE INDEX IF NOT EXISTS "bookings_created_idx" ON "bookings" ("created_at");
