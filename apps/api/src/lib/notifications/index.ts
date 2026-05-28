/**
 * Notification dispatcher port. Phase 13 (Track B).
 *
 * Three channels (SMS, email, WhatsApp), each behind a provider interface.
 * The dispatcher writes a `notifications` row, hands off to the channel
 * provider, and updates the row with the result. In stub mode the row is
 * still written so audit + UI work without real providers.
 */
import { db } from '../../db/client.js';
import { notifications, type NewNotification } from '../../db/schema/notifications.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import { getSmsProvider, type SmsProvider } from './sms.js';
import { getEmailProvider, type EmailProvider } from './email.js';
import { getWhatsappProvider, type WhatsappProvider } from './whatsapp.js';

export interface DispatchInput {
  tenantId?: string | null | undefined;
  userId?: string | null | undefined;
  channel: 'sms' | 'email' | 'whatsapp';
  recipient: string;
  templateKey: string;
  payload?: Record<string, unknown> | undefined;
  /** Defer dispatch to a future time (e.g. T-24h reminders). */
  scheduledFor?: Date | null | undefined;
}

export interface DispatchResult {
  notificationId: string;
  status: 'sent' | 'pending' | 'failed';
  providerMessageId?: string | undefined;
}

export interface NotificationsAdapter {
  dispatch(input: DispatchInput): Promise<DispatchResult>;
  /** Worker drain: process pending+due rows. Returns how many were attempted. */
  processPending(limit?: number): Promise<number>;
}

class DefaultDispatcher implements NotificationsAdapter {
  constructor(
    private readonly sms: SmsProvider,
    private readonly email: EmailProvider,
    private readonly whatsapp: WhatsappProvider,
  ) {}

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const row: NewNotification = {
      tenantId: input.tenantId ?? null,
      userId: input.userId ?? null,
      channel: input.channel,
      recipient: input.recipient,
      templateKey: input.templateKey,
      payload: input.payload ?? {},
      scheduledFor: input.scheduledFor ?? null,
      status: input.scheduledFor && input.scheduledFor > new Date() ? 'pending' : 'pending',
    };
    const [inserted] = await db.insert(notifications).values(row).returning();
    if (!inserted) throw new Error('notifications_insert_failed');

    // If scheduledFor is in the future, leave it pending for the worker.
    if (input.scheduledFor && input.scheduledFor > new Date()) {
      return { notificationId: inserted.id, status: 'pending' };
    }

    return this.send(inserted.id, input);
  }

  private async send(
    id: string,
    input: DispatchInput,
  ): Promise<DispatchResult> {
    const provider =
      input.channel === 'sms' ? this.sms : input.channel === 'email' ? this.email : this.whatsapp;
    try {
      const r = await provider.send({
        recipient: input.recipient,
        templateKey: input.templateKey,
        payload: input.payload ?? {},
      });
      await db
        .update(notifications)
        .set({
          status: 'sent',
          providerMessageId: r.providerMessageId ?? null,
          sentAt: new Date(),
        })
        .where(eq(notifications.id, id));
      return { notificationId: id, status: 'sent', providerMessageId: r.providerMessageId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(notifications)
        .set({ status: 'failed', error: msg })
        .where(eq(notifications.id, id));
      logger.warn({ err }, 'notification_send_failed');
      return { notificationId: id, status: 'failed' };
    }
  }

  async processPending(limit = 50): Promise<number> {
    // TODO(phase-13): SELECT pending + scheduled_for <= now() FOR UPDATE SKIP LOCKED;
    // for each row, recreate a DispatchInput and call this.send(). Left for the
    // notifications subagent — the schema and indices are already in place.
    logger.debug({ limit }, 'notifications_process_pending_stub');
    return 0;
  }
}

let cached: NotificationsAdapter | undefined;

export function getNotifications(): NotificationsAdapter {
  if (cached) return cached;
  cached = new DefaultDispatcher(getSmsProvider(), getEmailProvider(), getWhatsappProvider());
  return cached;
}

/** Test-only reset. */
export function __resetNotificationsForTesting(): void {
  cached = undefined;
}

export * from './types.js';
