import { ApiError } from '@/lib/api/client';

/**
 * What a draft still lacks before it can go to review, as the API reports
 * it: on the detail reads as `missing`, and in the 409 `*_incomplete`
 * refusal's details. The keys are the API's; the words are ours.
 */
export type MissingKey = 'dates' | 'location' | 'tiers';

const COPY: Record<MissingKey, string> = {
  dates: 'a start and end',
  location: 'a venue or address',
  tiers: 'a ticket tier',
};

/** "a start and end, a venue or address" — in the API's order; '' when nothing is missing. */
export function missingCopy(keys: readonly string[] | undefined): string {
  return (keys ?? []).map((k) => COPY[k as MissingKey] ?? k).join(', ');
}

/**
 * A refusal's message, with what is still needed when the API said so:
 * "This event is not complete yet — still needed: a start and end, a ticket
 * tier." Any other error reads as it came.
 */
export function describeRefusal(err: unknown): string {
  if (err instanceof ApiError && err.code.endsWith('_incomplete')) {
    const missing = Array.isArray(err.details?.['missing']) ? (err.details['missing'] as string[]) : [];
    return missing.length ? `${err.message} — still needed: ${missingCopy(missing)}.` : err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
