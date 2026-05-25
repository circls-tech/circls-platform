import { PgBoss, type Job } from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sweepExpiredHolds } from '../services/slot_service.js';

/** Queue / scheduled-job name for the stale-hold reaper. */
const HOLD_SWEEP_QUEUE = 'hold-sweep';
/** Run the reaper every minute. */
const HOLD_SWEEP_CRON = '*/1 * * * *';

/**
 * Process-wide PgBoss handle. Held at module scope so `stopWorker()` can stop
 * the same instance `startWorker()` created. Null when the worker is not running.
 */
let boss: PgBoss | null = null;

/**
 * Boot the in-process pg-boss worker:
 *   1. open a PgBoss on DATABASE_URL (it self-creates its `pgboss` schema),
 *   2. ensure the `hold-sweep` queue exists,
 *   3. register a worker that runs `sweepExpiredHolds()` and logs the freed count,
 *   4. schedule the queue on a 1-minute cron.
 *
 * pg-boss v10+ delivers an ARRAY of jobs to the work handler (verified against
 * the installed v12 types: `WorkHandler = (job: Job<T>[]) => Promise<ResData>`),
 * hence the `jobs: Job[]` parameter.
 *
 * Idempotent: a second call while already running is a no-op.
 */
export async function startWorker(): Promise<void> {
  if (boss) {
    logger.warn('worker_already_running');
    return;
  }

  const instance = new PgBoss(env.DATABASE_URL);

  // pg-boss surfaces background/runtime failures via the 'error' event. Without
  // a listener these would propagate as unhandled and could crash the process.
  instance.on('error', (err) => {
    logger.error({ err }, 'pgboss_error');
  });

  await instance.start();
  await instance.createQueue(HOLD_SWEEP_QUEUE);

  await instance.work(HOLD_SWEEP_QUEUE, async (_jobs: Job[]) => {
    const freed = await sweepExpiredHolds();
    logger.info({ freed }, 'hold_sweep_complete');
  });

  await instance.schedule(HOLD_SWEEP_QUEUE, HOLD_SWEEP_CRON);

  boss = instance;
  logger.info({ cron: HOLD_SWEEP_CRON }, 'worker_started');
}

/**
 * Stop the worker gracefully (lets in-flight jobs finish), then release the
 * handle. Safe to call when the worker was never started.
 */
export async function stopWorker(): Promise<void> {
  if (!boss) return;
  const instance = boss;
  boss = null;
  await instance.stop({ graceful: true });
  logger.info('worker_stopped');
}
