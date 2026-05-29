import { PgBoss, type Job } from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sweepExpiredHolds } from '../services/slot_service.js';
import { processPendingNotifications } from '../services/notification_service.js';
import { pollKycStatuses } from '../services/kyc_service.js';
import { releaseDueSettlements } from '../services/settlement_hold_service.js';
import { sweepAbandonedCarts } from '../services/booking_service_track_b.js';
import { reconcilePayouts } from '../services/refund_service.js';
import { deliverPendingOutboundWebhooks } from '../services/webhook_subscriptions_service.js';

/**
 * In-process pg-boss worker. One queue per scheduled job; each handler delegates
 * to a service function so the business logic stays unit-testable without
 * pg-boss in scope.
 *
 * Cron schedules are conservative (1m / 5m / 30m / daily). Subagent phases can
 * tighten them as needed when they fill in the handler bodies.
 */

interface ScheduledJob {
  queue: string;
  cron: string;
  /** Workhorse called by the queue handler. */
  run: () => Promise<void>;
}

const JOBS: ScheduledJob[] = [
  {
    queue: 'hold-sweep',
    cron: '*/1 * * * *',
    run: async () => {
      const freed = await sweepExpiredHolds();
      logger.info({ freed }, 'hold_sweep_complete');
    },
  },
  {
    queue: 'notifications-dispatch',
    cron: '*/1 * * * *',
    run: async () => {
      const sent = await processPendingNotifications();
      if (sent > 0) logger.info({ sent }, 'notifications_dispatch_complete');
    },
  },
  {
    queue: 'kyc-status-poll',
    cron: '*/30 * * * *',
    run: async () => {
      const polled = await pollKycStatuses();
      if (polled > 0) logger.info({ polled }, 'kyc_status_poll_complete');
    },
  },
  {
    queue: 'settlement-release-ticker',
    cron: '*/5 * * * *',
    run: async () => {
      const released = await releaseDueSettlements();
      if (released > 0) logger.info({ released }, 'settlement_release_complete');
    },
  },
  {
    queue: 'abandoned-cart-sweep',
    cron: '*/1 * * * *',
    run: async () => {
      const cancelled = await sweepAbandonedCarts();
      if (cancelled > 0) logger.info({ cancelled }, 'abandoned_cart_sweep_complete');
    },
  },
  {
    queue: 'payout-reconciliation',
    cron: '15 2 * * *', // 02:15 UTC daily
    run: async () => {
      const reconciled = await reconcilePayouts();
      logger.info({ reconciled }, 'payout_reconciliation_complete');
    },
  },
  {
    queue: 'outbound-webhook-delivery',
    cron: '*/1 * * * *',
    run: async () => {
      const delivered = await deliverPendingOutboundWebhooks(
        env.WEBHOOK_DELIVERY_CONCURRENCY,
      );
      if (delivered > 0) logger.info({ delivered }, 'outbound_webhook_delivery_complete');
    },
  },
];

let boss: PgBoss | null = null;

export async function startWorker(): Promise<void> {
  if (boss) {
    logger.warn('worker_already_running');
    return;
  }

  const instance = new PgBoss(env.DATABASE_URL);
  instance.on('error', (err) => {
    logger.error({ err }, 'pgboss_error');
  });

  await instance.start();

  for (const job of JOBS) {
    await instance.createQueue(job.queue);
    await instance.work(job.queue, async (_jobs: Job[]) => {
      try {
        await job.run();
      } catch (err) {
        logger.error({ err, queue: job.queue }, 'scheduled_job_failed');
        throw err;
      }
    });
    await instance.schedule(job.queue, job.cron);
  }

  boss = instance;
  logger.info({ queues: JOBS.map((j) => j.queue) }, 'worker_started');
}

export async function stopWorker(): Promise<void> {
  if (!boss) return;
  const instance = boss;
  boss = null;
  await instance.stop({ graceful: true });
  logger.info('worker_stopped');
}
