import { db } from '../db/client.js';
import { loginEvents } from '../db/schema/index.js';

/** Portals that can record a login. Plain text in the DB; validated at the route. */
export const LOGIN_SOURCES = ['consumer', 'partners', 'admin'] as const;
export type LoginSource = (typeof LOGIN_SOURCES)[number];

/**
 * Append a login_events row for a user. Called once per fresh sign-in from the
 * frontends (see POST /v1/me/login). Best-effort audit data — callers should
 * not let a failure here block the sign-in flow.
 */
export async function recordLogin(userId: string, source: LoginSource | null): Promise<void> {
  await db.insert(loginEvents).values({ userId, source });
}
