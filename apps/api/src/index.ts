import { env } from './config/env.js';
import { closeDb, pingDb } from './db/client.js';
import { logger } from './lib/logger.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  try {
    await pingDb();
    logger.info('db_connected');
  } catch (err) {
    logger.fatal({ err }, 'db_connection_failed');
    process.exit(1);
  }

  const app = await buildServer();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutdown_start');
    try {
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
}

void main();
