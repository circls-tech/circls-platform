/**
 * Server-driven UI screens (docs/SDUI.md): the versioned layouts the mobile
 * apps fetch, the feature flags they evaluate `visible` conditions against,
 * and the soft/force update notice. Public reads come from a 15s in-process
 * cache per app (the apps poll the manifest on every launch); admin writes
 * drop it.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { platformSettings, screenLayouts } from '../db/schema/index.js';
import type { MinBuild, ScreenLayout, SduiApp } from '../db/schema/screen_layouts.js';
import { writeAudit } from '../lib/audit.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { Conflict, NotFound } from '../lib/errors.js';
import type { Screen } from '../lib/sdui/schema.js';
import { type ClientInfo, manifestScreens, selectPublished } from '../lib/sdui/select.js';

const CACHE_MS = 15_000;
/** Published rows kept per screen; older ones are archived on publish. */
const KEEP_PUBLISHED = 5;
const HISTORY_LIMIT = 20;

export type SduiFlags = Record<string, boolean>;
export interface SduiUpdateNotice {
  minSupportedBuild: Record<string, number>;
  message: { title: string; body: string; url: string };
}

interface AppSnapshot {
  rows: ScreenLayout[];
  flags: SduiFlags;
  update: SduiUpdateNotice | null;
  at: number;
}
const cache = new Map<SduiApp, AppSnapshot>();

const flagsKey = (app: SduiApp) => `sdui.flags.${app}`;
const updateKey = (app: SduiApp) => `sdui.update.${app}`;

async function readSetting(key: string): Promise<unknown> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
  return row?.value;
}

function asFlags(value: unknown): SduiFlags {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: SduiFlags = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'boolean') out[k] = v;
  return out;
}

function asUpdate(value: unknown): SduiUpdateNotice | null {
  if (!value || typeof value !== 'object') return null;
  return value as SduiUpdateNotice;
}

async function snapshot(app: SduiApp): Promise<AppSnapshot> {
  const now = Date.now();
  const hit = cache.get(app);
  if (hit && now - hit.at <= CACHE_MS) return hit;
  const [rows, flags, update] = await Promise.all([
    db
      .select()
      .from(screenLayouts)
      .where(and(eq(screenLayouts.app, app), eq(screenLayouts.status, 'published')))
      .orderBy(desc(screenLayouts.version)),
    readSetting(flagsKey(app)),
    readSetting(updateKey(app)),
  ]);
  const snap = { rows, flags: asFlags(flags), update: asUpdate(update), at: now };
  cache.set(app, snap);
  return snap;
}

function invalidate(app: SduiApp): void {
  cache.delete(app);
}

/** Test-only: forget every cached snapshot. */
export function __resetScreensCacheForTesting(): void {
  cache.clear();
}

/** The document a row serves: `screen`, `version` and `minBuild` come from the row. */
export function rowToScreen(row: ScreenLayout): Screen {
  const body = row.body as unknown as Screen;
  return { ...body, screen: `${row.app}.${row.key}`, version: row.version, minBuild: row.minBuild };
}

// ── Public ────────────────────────────────────────────────────────────────

export interface Manifest {
  app: SduiApp;
  flags: SduiFlags;
  screens: Record<string, { version: number }>;
  update: SduiUpdateNotice | null;
  generatedAt: string;
}

export async function getManifest(app: SduiApp, client: ClientInfo): Promise<Manifest> {
  const snap = await snapshot(app);
  return {
    app,
    flags: snap.flags,
    screens: manifestScreens(snap.rows, client),
    update: snap.update,
    generatedAt: new Date().toISOString(),
  };
}

/** The published row this client should render for `key`, or undefined. */
export async function getPublishedScreen(
  app: SduiApp,
  key: string,
  client: ClientInfo,
): Promise<ScreenLayout | undefined> {
  const snap = await snapshot(app);
  return selectPublished(
    snap.rows.filter((r) => r.key === key),
    client,
  );
}

// ── Admin ─────────────────────────────────────────────────────────────────

export interface ScreenSummary {
  app: SduiApp;
  key: string;
  publishedVersion: number | null;
  draftVersion: number | null;
  updatedAt: string;
}

export async function listScreens(app: SduiApp): Promise<ScreenSummary[]> {
  const rows = await db.execute<{
    key: string;
    published_version: number | null;
    draft_version: number | null;
    updated_at: Date | string;
  }>(sql`
    SELECT key,
           max(version) FILTER (WHERE status = 'published') AS published_version,
           max(version) FILTER (WHERE status = 'draft')     AS draft_version,
           max(greatest(created_at, coalesce(published_at, created_at))) AS updated_at
    FROM screen_layouts
    WHERE app = ${app}
    GROUP BY key
    ORDER BY key
  `);
  return (rows as unknown as (typeof rows)[number][]).map((r) => ({
    app,
    key: r.key,
    publishedVersion: r.published_version === null ? null : Number(r.published_version),
    draftVersion: r.draft_version === null ? null : Number(r.draft_version),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

/** A row without its body, for history lists. */
export type ScreenLayoutHead = Omit<ScreenLayout, 'body'>;

export function headOf(row: ScreenLayout): ScreenLayoutHead {
  const { body: _body, ...head } = row;
  return head;
}

export interface ScreenDetail {
  published: ScreenLayout | null;
  draft: ScreenLayout | null;
  history: ScreenLayoutHead[];
}

async function rowsOf(app: SduiApp, key: string): Promise<ScreenLayout[]> {
  return db
    .select()
    .from(screenLayouts)
    .where(and(eq(screenLayouts.app, app), eq(screenLayouts.key, key)))
    .orderBy(desc(screenLayouts.version));
}

export async function getScreenDetail(app: SduiApp, key: string): Promise<ScreenDetail> {
  const rows = await rowsOf(app, key);
  if (rows.length === 0) throw new NotFound('Screen not found', 'not_found');
  return {
    published: rows.find((r) => r.status === 'published') ?? null,
    draft: rows.find((r) => r.status === 'draft') ?? null,
    history: rows.slice(0, HISTORY_LIMIT).map(headOf),
  };
}

export async function getScreenVersion(app: SduiApp, key: string, version: number): Promise<ScreenLayout> {
  const [row] = await db
    .select()
    .from(screenLayouts)
    .where(and(eq(screenLayouts.app, app), eq(screenLayouts.key, key), eq(screenLayouts.version, version)))
    .limit(1);
  if (!row) throw new NotFound('Version not found', 'not_found');
  return row;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextVersion(tx: Tx, app: SduiApp, key: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${screenLayouts.version})` })
    .from(screenLayouts)
    .where(and(eq(screenLayouts.app, app), eq(screenLayouts.key, key)));
  return Number(row?.max ?? 0) + 1;
}

/** Beyond the newest KEEP_PUBLISHED published rows, mark the rest archived. */
async function archiveOld(tx: Tx, app: SduiApp, key: string): Promise<void> {
  await tx.execute(sql`
    UPDATE screen_layouts SET status = 'archived'
    WHERE id IN (
      SELECT id FROM screen_layouts
      WHERE app = ${app} AND key = ${key} AND status = 'published'
      ORDER BY version DESC OFFSET ${KEEP_PUBLISHED}
    )
  `);
}

export interface DraftInput {
  body: Screen;
  minBuild?: MinBuild | undefined;
  note?: string | undefined;
}

/** Create or replace the single draft for a screen. */
export async function saveDraft(
  app: SduiApp,
  key: string,
  input: DraftInput,
  actorUserId: string,
): Promise<ScreenLayout> {
  const minBuild = input.minBuild ?? input.body.minBuild ?? {};
  const { minBuild: _mb, ...body } = input.body;
  const stored = body as unknown as Record<string, unknown>;
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(screenLayouts)
      .where(and(eq(screenLayouts.app, app), eq(screenLayouts.key, key), eq(screenLayouts.status, 'draft')))
      .limit(1);
    let saved: ScreenLayout;
    if (existing) {
      [saved] = (await tx
        .update(screenLayouts)
        .set({
          body: stored,
          minBuild,
          note: input.note ?? null,
          schemaVersion: input.body.schemaVersion,
          createdByUserId: actorUserId,
        })
        .where(eq(screenLayouts.id, existing.id))
        .returning()) as [ScreenLayout];
    } else {
      [saved] = (await tx
        .insert(screenLayouts)
        .values({
          app,
          key,
          version: await nextVersion(tx, app, key),
          status: 'draft',
          schemaVersion: input.body.schemaVersion,
          minBuild,
          body: stored,
          note: input.note ?? null,
          createdByUserId: actorUserId,
        })
        .returning()) as [ScreenLayout];
    }
    return saved;
  });
  await audit(actorUserId, 'platform.screen_draft_saved', row, { app, key, version: row.version });
  return row;
}

/** The draft becomes the live layout. */
export async function publishDraft(app: SduiApp, key: string, actorUserId: string): Promise<ScreenLayout> {
  const row = await db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(screenLayouts)
      .where(and(eq(screenLayouts.app, app), eq(screenLayouts.key, key), eq(screenLayouts.status, 'draft')))
      .limit(1);
    if (!draft) throw new Conflict('No draft to publish', 'no_draft');
    // A rollback since the draft was saved may hold a higher version; the
    // published draft must still be the newest, so move it past everything.
    const [other] = await tx
      .select({ max: sql<number | null>`max(${screenLayouts.version})` })
      .from(screenLayouts)
      .where(
        and(eq(screenLayouts.app, app), eq(screenLayouts.key, key), sql`${screenLayouts.id} <> ${draft.id}`),
      );
    const maxOther = Number(other?.max ?? 0);
    const version = draft.version > maxOther ? draft.version : maxOther + 1;
    const [published] = (await tx
      .update(screenLayouts)
      .set({ status: 'published', publishedAt: new Date(), version })
      .where(eq(screenLayouts.id, draft.id))
      .returning()) as [ScreenLayout];
    await archiveOld(tx, app, key);
    return published;
  });
  invalidate(app);
  await audit(actorUserId, 'platform.screen_published', row, { app, key, version: row.version });
  return row;
}

/** Re-publish an earlier version's body as a NEW version (history stays append-only). */
export async function rollbackTo(
  app: SduiApp,
  key: string,
  version: number,
  actorUserId: string,
): Promise<ScreenLayout> {
  const row = await db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(screenLayouts)
      .where(and(eq(screenLayouts.app, app), eq(screenLayouts.key, key), eq(screenLayouts.version, version)))
      .limit(1);
    if (!source) throw new NotFound('Version not found', 'not_found');
    if (source.status === 'draft') throw new Conflict('That version is the draft; publish it instead', 'is_draft');
    const [created] = (await tx
      .insert(screenLayouts)
      .values({
        app,
        key,
        version: await nextVersion(tx, app, key),
        status: 'published',
        schemaVersion: source.schemaVersion,
        minBuild: source.minBuild,
        body: source.body,
        note: `Rollback to v${source.version}`,
        createdByUserId: actorUserId,
        publishedAt: new Date(),
      })
      .returning()) as [ScreenLayout];
    await archiveOld(tx, app, key);
    return created;
  });
  invalidate(app);
  await audit(actorUserId, 'platform.screen_rolled_back', row, { app, key, from: version, version: row.version });
  return row;
}

export async function deleteDraft(app: SduiApp, key: string, actorUserId: string): Promise<void> {
  const [deleted] = await db
    .delete(screenLayouts)
    .where(and(eq(screenLayouts.app, app), eq(screenLayouts.key, key), eq(screenLayouts.status, 'draft')))
    .returning();
  if (!deleted) throw new NotFound('No draft', 'not_found');
  await audit(actorUserId, 'platform.screen_draft_deleted', deleted, null);
}

async function audit(
  actorUserId: string,
  action: string,
  row: ScreenLayout,
  after: Record<string, unknown> | null,
): Promise<void> {
  await writeAudit(
    db,
    { tenantId: await getPlatformTenantId(), actorUserId },
    action,
    'screen_layout',
    row.id,
    after ? null : { app: row.app, key: row.key, version: row.version },
    after,
  );
}

// ── Flags + update notice (platform_settings) ─────────────────────────────

export async function getFlags(app: SduiApp): Promise<SduiFlags> {
  return asFlags(await readSetting(flagsKey(app)));
}

export async function getUpdateNotice(app: SduiApp): Promise<SduiUpdateNotice | null> {
  return asUpdate(await readSetting(updateKey(app)));
}

async function writeSetting(key: string, value: unknown, actorUserId: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value, updatedByUserId: actorUserId })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value, updatedByUserId: actorUserId, updatedAt: new Date() },
    });
}

async function auditSetting(
  actorUserId: string,
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  const platformTenantId = await getPlatformTenantId();
  await writeAudit(db, { tenantId: platformTenantId, actorUserId }, action, 'platform', platformTenantId, before, after);
}

/** Replace the whole flag map for an app. */
export async function setFlags(app: SduiApp, flags: SduiFlags, actorUserId: string): Promise<SduiFlags> {
  const before = await getFlags(app);
  await writeSetting(flagsKey(app), flags, actorUserId);
  invalidate(app);
  await auditSetting(actorUserId, 'platform.sdui_flags_changed', { app, flags: before }, { app, flags });
  return flags;
}

/** Set (or with null, clear) the update notice for an app. */
export async function setUpdateNotice(
  app: SduiApp,
  notice: SduiUpdateNotice | null,
  actorUserId: string,
): Promise<SduiUpdateNotice | null> {
  const before = await getUpdateNotice(app);
  if (notice) await writeSetting(updateKey(app), notice, actorUserId);
  else await db.delete(platformSettings).where(eq(platformSettings.key, updateKey(app)));
  invalidate(app);
  await auditSetting(actorUserId, 'platform.sdui_update_changed', { app, update: before }, { app, update: notice });
  return notice;
}

/** The draft row for the admin preview path (`?draft=1`), or undefined. */
export async function getDraft(app: SduiApp, key: string): Promise<ScreenLayout | undefined> {
  const [row] = await db
    .select()
    .from(screenLayouts)
    .where(and(eq(screenLayouts.app, app), eq(screenLayouts.key, key), eq(screenLayouts.status, 'draft')))
    .limit(1);
  return row;
}
