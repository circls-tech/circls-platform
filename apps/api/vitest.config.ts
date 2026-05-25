import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // Integration tests share one Postgres. Most tests are tenant-scoped (safe
    // in parallel), but sweepExpiredHolds() is a GLOBAL mutation, so run test
    // files sequentially to avoid cross-file races (and any future global jobs).
    fileParallelism: false,
  },
});
