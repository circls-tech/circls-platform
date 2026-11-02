/**
 * Which published layout a given app build gets (pure; the service feeds it
 * the rows). A row is eligible when its schema_version is one the client
 * understands and its min_build for the caller's platform (or '*') is at or
 * below the caller's build; among those the highest version wins.
 */
import type { MinBuild } from '../../db/schema/screen_layouts.js';

export interface ClientInfo {
  platform?: string | undefined;
  /** Absent = unconstrained (a curl, the admin): every minBuild is satisfied. */
  build?: number | undefined;
  /** The newest document schema the client renders (default 1). */
  schema?: number | undefined;
}

export interface SelectableRow {
  key: string;
  version: number;
  status: string;
  schemaVersion: number;
  minBuild: MinBuild;
}

export function minBuildSatisfied(minBuild: MinBuild, client: ClientInfo): boolean {
  if (client.build === undefined) return true;
  const required = Math.max(
    client.platform !== undefined ? (minBuild[client.platform] ?? 0) : 0,
    minBuild['*'] ?? 0,
  );
  return client.build >= required;
}

export function isEligible(row: SelectableRow, client: ClientInfo): boolean {
  return (
    row.status === 'published' &&
    row.schemaVersion <= (client.schema ?? 1) &&
    minBuildSatisfied(row.minBuild, client)
  );
}

/** The highest eligible published version among `rows` (one screen), or undefined. */
export function selectPublished<T extends SelectableRow>(rows: readonly T[], client: ClientInfo): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (!isEligible(row, client)) continue;
    if (!best || row.version > best.version) best = row;
  }
  return best;
}

/** Per screen key, the version the manifest advertises to this client. */
export function manifestScreens(
  rows: readonly SelectableRow[],
  client: ClientInfo,
): Record<string, { version: number }> {
  const byKey = new Map<string, SelectableRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.key);
    if (list) list.push(row);
    else byKey.set(row.key, [row]);
  }
  const out: Record<string, { version: number }> = {};
  for (const key of [...byKey.keys()].sort()) {
    const chosen = selectPublished(byKey.get(key)!, client);
    if (chosen) out[key] = { version: chosen.version };
  }
  return out;
}
