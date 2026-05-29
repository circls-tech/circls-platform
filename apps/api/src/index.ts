import { and, eq } from 'drizzle-orm';
import { env } from './config/env.js';
import { closeDb, db, pingDb } from './db/client.js';
import { tenants } from './db/schema/tenants.js';
import { logger } from './lib/logger.js';
import { buildServer } from './server.js';
import { startWorker, stopWorker } from './worker/index.js';

async function main(): Promise<void> {
  try {
    await pingDb();
    logger.info('db_connected');
  } catch (err) {
    logger.fatal({ err }, 'db_connection_failed');
    process.exit(1);
  }

  // Non-fatal boot sanity check: warn if the platform tenant is missing.
  // Read slug via process.env so override in tests works post-module-load.
  {
    const slug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'] ?? env.CIRCLS_INTERNAL_TENANT_SLUG;
    const [platform] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.slug, slug), eq(tenants.isPlatform, true)));
    if (!platform) {
      logger.warn(
        { slug },
        'circls_internal_tenant_missing — run scripts/bootstrap_circls_tenant.ts',
      );
    }
  }

  const app = await buildServer();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutdown_start');
    try {
      // Stop the worker first so an in-flight sweep can finish gracefully
      // before we tear down the HTTP server and DB pool.
      await stopWorker();
      await app.close();
      await closeDb();
      logger.info('shutdown_complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown_error');
      process.exit(1);
    }
  };

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      void shutdown(sig);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled_rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught_exception');
    process.exit(1);
  });

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    logger.fatal({ err }, 'listen_failed');
    process.exit(1);
  }

  // Start the in-process pg-boss worker once HTTP is serving. Opt-out via
  // RUN_WORKER=false (used by tests). Non-fatal: if pg-boss fails to start we
  // log and keep serving HTTP rather than crashing the API.
  if (process.env.RUN_WORKER !== 'false') {
    try {
      await startWorker();
    } catch (err) {
      logger.error({ err }, 'worker_start_failed');
    }
  } else {
    logger.info('worker_disabled');
  }
}

void main();
