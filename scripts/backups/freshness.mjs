// Pure helpers for the backup freshness check. No external deps so it runs anywhere
// (CI, droplet, local) with just node. Consumed by check-freshness.mjs.

/** True if the newest backup is older than maxAgeHours, or missing entirely. */
export function isStale(latestIso, nowMs, maxAgeHours) {
  if (!latestIso) return true;
  const t = Date.parse(latestIso);
  if (Number.isNaN(t)) return true;
  return nowMs - t > maxAgeHours * 3600 * 1000;
}

/** Newest LastModified (ISO string) from `aws s3api list-objects-v2` JSON, or null. */
export function parseNewest(jsonText) {
  const data = JSON.parse(jsonText);
  const contents = Array.isArray(data.Contents) ? data.Contents : [];
  if (contents.length === 0) return null;
  return contents
    .map((o) => o.LastModified)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}
