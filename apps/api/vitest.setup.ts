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
