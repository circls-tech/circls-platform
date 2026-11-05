import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { users } from './users.js';

export const SDUI_APPS = ['consumer', 'partners'] as const;
export type SduiApp = (typeof SDUI_APPS)[number];
export type ScreenLayoutStatus = 'draft' | 'published' | 'archived';
/** Lowest app build per platform ('ios' | 'android' | '*') that may render a layout. */
export type MinBuild = Record<string, number>;

/**
 * Server-driven UI: versioned screen documents the mobile apps fetch and
 * render (see lib/sdui/schema.ts for the document, services/screens_service
 * for selection). One row per (app, key, version); at most one draft per
 * screen; history is append-only (a rollback is a new published row).
 */
export const screenLayouts = pgTable(
  'screen_layouts',
  {
    id: uuidPk(),
    app: text('app').$type<SduiApp>().notNull(),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    status: text('status').$type<ScreenLayoutStatus>().notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    minBuild: jsonb('min_build').$type<MinBuild>().notNull().default({}),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    note: text('note'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    unique('screen_layouts_app_key_version_uq').on(t.app, t.key, t.version),
    uniqueIndex('screen_layouts_one_draft_uq')
      .on(t.app, t.key)
      .where(sql`${t.status} = 'draft'`),
    index('screen_layouts_app_key_status_idx').on(t.app, t.key, t.status),
  ],
);

export type ScreenLayout = typeof screenLayouts.$inferSelect;
export type NewScreenLayout = typeof screenLayouts.$inferInsert;
