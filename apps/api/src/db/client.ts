import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

/**
 * Single postgres-js connection pool for the process. Postgres runs on the
 * same Coolify VPS over a private network, so prepared statements stay ON
 * (no external pgbouncer to placate). Pool kept small per the locked decision.
 */
const queryClient = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(queryClient, { schema });
export type Database = typeof db;

/** Liveness check run at boot — throws if the DB is unreachable. */
export async function pingDb(): Promise<void> {
  await db.execute(sql`select 1`);
}

/** Drain the pool on graceful shutdown. */
export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
