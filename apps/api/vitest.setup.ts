// Importing app modules pulls in src/config/env.ts, which requires a valid
// DATABASE_URL. Unit tests that never touch the DB still trigger that import,
// so give env validation a harmless placeholder when one isn't provided.
// Integration tests opt in explicitly via RUN_INTEGRATION + a real DATABASE_URL.
process.env.DATABASE_URL ??= 'postgres://placeholder@127.0.0.1:5432/placeholder';
