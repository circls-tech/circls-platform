/**
 * Links into the consumer app (circls.app) — used to hand partners a shareable
 * URL for their listings (e.g. private-link events). Override per environment
 * via NEXT_PUBLIC_CONSUMER_BASE_URL (sandbox: http://localhost:3003).
 */
export const CONSUMER_BASE_URL =
  process.env.NEXT_PUBLIC_CONSUMER_BASE_URL ?? 'https://circls.app';

export function consumerEventUrl(eventId: string): string {
  return `${CONSUMER_BASE_URL}/events/${eventId}`;
}
