import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema/index.js';

export interface IdemResult<T> {
  status: number;
  body: T;
}

/**
 * Run `produce` at most once per idempotency key. On replay, returns the stored
 * status + body. (The slot uniqueness itself is also guaranteed by the bookings
 * GIST constraint, so this is the belt to that suspenders.)
 */
export async function withIdempotency<T>(
  key: string,
  tenantId: string | null,
  produce: () => Promise<IdemResult<T>>,
): Promise<IdemResult<T> & { replayed: boolean }> {
  const existing = await db.query.idempotencyKeys.findFirst({
    where: eq(idempotencyKeys.key, key),
  });
  if (existing) {
    return { status: existing.statusCode, body: existing.responseJson as T, replayed: true };
  }
  const result = await produce();
  await db
    .insert(idempotencyKeys)
    .values({
      key,
      tenantId,
      statusCode: result.status,
      responseJson: result.body as unknown,
    })
    .onConflictDoNothing();
  return { ...result, replayed: false };
}
