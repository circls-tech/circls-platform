import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

/**
 * Applies pending migrations, then exits. Run via `pnpm db:migrate`.
 * Uses a dedicated single connection (max: 1) so it never contends with the
 * app pool.
 */
async function main(): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL('./db/migrations', import.meta.url));
  const migrationClient = postgres(env.DATABASE_URL, { max: 1 });
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder });
    logger.info('migrations_applied');
  } finally {
    await migrationClient.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'migrate_failed');
  process.exit(1);
});
