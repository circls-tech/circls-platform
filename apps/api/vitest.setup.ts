// Importing app modules pulls in src/config/env.ts, which requires a valid
// DATABASE_URL. Unit tests that never touch the DB still trigger that import,
// so give env validation a harmless placeholder when one isn't provided.
// Integration tests opt in explicitly via RUN_INTEGRATION + a real DATABASE_URL.
process.env.DATABASE_URL ??= 'postgres://placeholder@127.0.0.1:5432/placeholder';

// Defense-in-depth: tests must never boot the in-process pg-boss worker (it
// would create a pgboss schema and run a real scheduler against the shared DB).
// Tests target sweepExpiredHolds() directly; the worker only starts from the
// index.ts bootstrap, which tests don't invoke — but pin RUN_WORKER off anyway.
process.env.RUN_WORKER = 'false';

// Tests must never reach a real payment gateway, whatever keys a developer's
// sandbox passes in (e.g. Cashfree sandbox keys via the repo-root .env). Clear
// them so every adapter runs in stub mode and INR routes to the default
// gateway. Tests that exercise a live adapter mock ../config/env.js instead.
for (const key of [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PUBLISHABLE_KEY',
  'CASHFREE_CLIENT_ID',
  'CASHFREE_CLIENT_SECRET',
  'CASHFREE_ENV',
  'INR_PAYMENT_GATEWAY',
]) {
  delete process.env[key];
}
